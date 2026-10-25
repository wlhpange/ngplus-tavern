import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { masters } from "../db/schema";
import { extractScene } from "./scene";
import { buildScenePrompt, generateImage } from "./mflux";
import { getImageConfig } from "./config";
import { resolveAsset, saveScene } from "../assets";
import { parseCard } from "../cards";
import { getRpSettings } from "../rp";
import {
  activateWorldBook,
  activatedWorldBookText,
  listWorldBookEntries,
} from "../worldbook";
import { getSession } from "../chatSessions";
import { inflightKey, setInflightRow, getInflightRow, delInflightRow } from "../inflight";

/**
 * 情景配图「后台任务」。
 *
 * 关键设计：生图**不绑定 HTTP 请求生命周期**。客户端（手机锁屏 / 切页 / 刷新）
 * 断开都不会中断生成——任务在服务端跑完并把图落盘（data/scenes/<消息id>.png），
 * 前台只要刷新就能看到。任务串行执行（同一时间只跑一个 mflux，避免抢内存）。
 *
 * 状态存内存：单用户、单进程足够。图是否已生成以**文件**为准（GET 先看文件）。
 */

export type SceneJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface SceneJob {
  messageId: string;
  status: SceneJobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const jobs = new Map<string, SceneJob>();
/**
 * 每个在途任务的取消控制器：用户点「停止」→ abort → mflux 子进程被 kill。
 * 与 jobs 分开存（SceneJob 要序列化给前端，不塞不可序列化的对象）。
 */
const controllers = new Map<string, AbortController>();
/** 串行链：保证同一时间只有一个 mflux 在跑 */
let chain: Promise<unknown> = Promise.resolve();

/** 任务状态镜像到数据库，刷新 / dev 模块重编译 / 进程重启后仍能恢复 */
function mirrorKey(messageId: string): string {
  return inflightKey("scene", messageId);
}
function writeMirror(
  db: Db,
  messageId: string,
  status: SceneJobStatus,
  startedAt: number,
  error?: string,
): void {
  setInflightRow(
    db,
    mirrorKey(messageId),
    JSON.stringify({ status, startedAt, ...(error ? { error } : {}) }),
  );
}
function clearMirror(db: Db, messageId: string): void {
  delInflightRow(db, mirrorKey(messageId));
}

export function getSceneJob(messageId: string, db?: Db | null): SceneJob | undefined {
  const mem = jobs.get(messageId);
  if (mem) return mem;
  if (!db) return undefined;
  // 内存丢了（刷新 / 重编译 / 重启）：从数据库镜像恢复
  const raw = getInflightRow(db, mirrorKey(messageId));
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { status?: SceneJobStatus; startedAt?: number; error?: string };
    const startedAt = o.startedAt ?? Date.now();
    // 兜底：超过最长生成窗口仍在跑 → 视为失效（进程已没了），清掉
    if (
      (o.status === "queued" || o.status === "running") &&
      Date.now() - startedAt > 35 * 60 * 1000
    ) {
      clearMirror(db, messageId);
      return undefined;
    }
    return { messageId, status: o.status ?? "running", startedAt, error: o.error };
  } catch {
    return undefined;
  }
}

/** 该消息是否正在（排队或运行）生成 */
export function isSceneGenerating(messageId: string, db?: Db | null): boolean {
  const j = getSceneJob(messageId, db);
  return !!j && (j.status === "queued" || j.status === "running");
}

/** 仅测试用：清空任务表与串行链，保证用例隔离 */
export function __resetSceneJobs(): void {
  jobs.clear();
  controllers.clear();
  imageRuns.clear();
  chain = Promise.resolve();
}

/**
 * 停止某条消息的配图任务：中止其生成进程（mflux 子进程被 kill），并把任务
 * 从表里移除——前端轮询立刻看到「空闲」，按钮复位。排队中的任务也会被跳过。
 * 返回是否确实有任务被停止。
 */
export function cancelSceneJob(messageId: string, db?: Db | null): boolean {
  const job = jobs.get(messageId);
  const controller = controllers.get(messageId);
  const mirrored = db ? getInflightRow(db, mirrorKey(messageId)) : null;
  if (!job && !controller && !mirrored) return false;
  // 先标记取消，串行链里的 execute 看到它就不会真正开始工作
  if (job) {
    job.status = "cancelled";
    job.finishedAt = Date.now();
    jobs.delete(messageId);
  }
  controllers.delete(messageId);
  controller?.abort();
  if (db) clearMirror(db, messageId);
  return true;
}

export interface SceneMessage {
  id: string;
  content: string;
  masterId: string | null;
  sessionId: string | null;
}

/** 可注入的「实际工作」（测试用；默认走真实 mflux）。signal 用于用户取消 */
export type SceneWork = (
  db: Db,
  userId: string,
  message: SceneMessage,
  prompt: string | undefined,
  signal: AbortSignal,
) => Promise<void>;

/**
 * 启动一条配图任务。立即返回（不等待生成）；同一消息重复点击只返回现有任务。
 * @param prompt 可选：用户指定的场景描述；缺省用 LLM 从消息提炼。
 */
export function startSceneJob(
  db: Db,
  userId: string,
  message: SceneMessage,
  prompt?: string,
  work: SceneWork = runSceneWork,
): SceneJob {
  const existing = jobs.get(message.id);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return existing;
  }
  const job: SceneJob = { messageId: message.id, status: "queued", startedAt: Date.now() };
  jobs.set(message.id, job);
  controllers.set(message.id, new AbortController());
  writeMirror(db, message.id, "queued", job.startedAt);
  pruneFinished();

  chain = chain
    .then(() => execute(db, userId, message, job, prompt, work))
    .catch(() => undefined);
  return job;
}

/** 状态机：排队 → 运行 → 完成/失败/取消。与「实际工作」解耦，便于测试。 */
async function execute(
  db: Db,
  userId: string,
  message: SceneMessage,
  job: SceneJob,
  prompt: string | undefined,
  work: SceneWork,
): Promise<void> {
  const controller = controllers.get(message.id);
  const cleanup = () => {
    jobs.delete(message.id);
    controllers.delete(message.id);
    clearMirror(db, message.id);
  };
  // 排队期间被取消：controller 已被 cancelSceneJob 移除/中止，直接跳过不启动 mflux
  if (!controller || controller.signal.aborted) {
    cleanup();
    return;
  }
  job.status = "running";
  job.startedAt = Date.now();
  writeMirror(db, message.id, "running", job.startedAt);
  try {
    await work(db, userId, message, prompt, controller.signal);
    // 完成与取消的竞态：取消后即使 work 正常返回也不落「完成」
    if (controller.signal.aborted) {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      cleanup();
      return;
    }
    job.status = "done";
    job.finishedAt = Date.now();
    // 成功：图已落盘，任务记录可删（是否已生成以文件为准）
    cleanup();
  } catch (e) {
    // 用户取消：不再记为错误
    if (controller.signal.aborted) {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      cleanup();
      return;
    }
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = e instanceof Error ? e.message : "生图失败";
    writeMirror(db, message.id, "error", job.startedAt, job.error);
    controllers.delete(message.id);
  }
}

// ---- 设置页「测试生图」的可取消运行（不落库、不挂消息，仅连通性测试） ----

const imageRuns = new Map<string, AbortController>();

/** 登记一次可取消的生图运行（设置页测试用），返回其控制器 */
export function registerImageRun(token: string): AbortController {
  const controller = new AbortController();
  imageRuns.set(token, controller);
  return controller;
}

/** 运行结束（成功/失败/取消）后清理登记 */
export function finishImageRun(token: string): void {
  imageRuns.delete(token);
}

/** 取消一次运行：abort → kill 后台 mflux 进程。返回是否确实取消了 */
export function cancelImageRun(token: string): boolean {
  const controller = imageRuns.get(token);
  if (!controller) return false;
  imageRuns.delete(token);
  controller.abort();
  return true;
}

/** 只保留最近若干条失败任务，避免内存里无限增长 */
function pruneFinished(): void {
  if (jobs.size <= 60) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status === "error")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const j of finished.slice(0, jobs.size - 60)) jobs.delete(j.messageId);
}

/** 真实工作：提炼场景 → 参考会话背景 → mflux 出图 → 落盘 */
async function runSceneWork(
  db: Db,
  userId: string,
  message: SceneMessage,
  prompt: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const cfg = getImageConfig(db);
  const context = buildSceneContext(db, userId, message);
  // 只用当前这一条回复提炼（一条回复可能含多个场景，交给提炼层挑主场景）
  const scene =
    prompt?.trim() ||
    (await extractScene(
      db,
      message.content,
      undefined,
      undefined,
      context,
      getRpSettings(db).enabled,
    ));
  const fullPrompt = buildScenePrompt(cfg.style, scene);
  const referencePaths = sessionBackgroundPaths(db, userId, message);

  // 用户可随时取消（abort → kill mflux 子进程）；另加 30 分钟安全超时兜底。
  const bytes = await generateImage(cfg, {
    prompt: fullPrompt,
    referencePaths,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
  });

  const filename = saveScene(message.id, bytes);
  if (!filename) throw new Error("配图保存失败");
}

type RouteDb = Db;

/** 人物外形 / 衣着 / 风格：会长卡描述 + 命中当前消息关键词的世界书条目 */
function buildSceneContext(
  db: RouteDb,
  userId: string,
  msg: { masterId: string | null; content: string },
): string {
  const parts: string[] = [];

  if (msg.masterId) {
    const master = db.select().from(masters).where(eq(masters.id, msg.masterId)).get();
    if (master) {
      try {
        const card = parseCard(master.personaJson);
        if (card.description) parts.push(`人物「${master.name}」：${card.description}`);
      } catch {
        /* 卡数据坏了就跳过，不阻断生图 */
      }
    }

    const entries = listWorldBookEntries(db, userId, msg.masterId);
    if (entries.length > 0) {
      const activation = activateWorldBook(entries, {
        messages: [{ role: "user", content: msg.content }],
      });
      const text = activatedWorldBookText(activation).trim();
      if (text) parts.push(text);
    }
  }

  return parts.join("\n");
}

/** 参考图：该聊天会话的背景图（有则用图像条件生成，无则纯文生图） */
function sessionBackgroundPaths(
  db: RouteDb,
  userId: string,
  msg: { sessionId: string | null },
): string[] {
  if (!msg.sessionId) return [];
  const session = getSession(db, userId, msg.sessionId);
  if (!session?.scene) return [];
  const filePath = resolveAsset("background", session.scene);
  return filePath ? [filePath] : [];
}
