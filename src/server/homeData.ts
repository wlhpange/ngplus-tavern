import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { masters, saves } from "./db/schema";
import type { ChatMode } from "./records";
import {
  chatWindowStart,
  hasRecordsBefore,
  queryRecords,
  type RecordItem,
} from "./records";
import {
  ensureActiveSession,
  getSession,
  listSessions,
} from "./chatSessions";
import { assetUrl, listSceneFiles } from "./assets";
import { activeSceneJobs } from "./image/jobs";
import { getImageConfig } from "./image/config";
import { getChatMasterId } from "./masters";
import {
  chatGreetingOptions,
  ensureChatGreeting,
} from "./llm/conversation";
import { isPending, pendingKey } from "./llm/pending";
import type { HistoryResponse } from "@/components/chat/types";

/** 增量轮询一页上限：离线一阵后回来也能一次补齐 */
export const MAX_INCREMENTAL = 200;

export interface HomeDataOptions {
  mode: ChatMode;
  /** 聊天模式：指定会话（校验归属；不传则取/建活跃会话） */
  sessionId?: string | null;
  /** 向前翻页游标（聊天模式） */
  before?: number | null;
  /** 增量轮询游标：只回该时刻之后落库的内容 */
  since?: number | null;
}

/**
 * 对话主界面数据（GET /api/chat 与首屏 SSR 共用）。
 *
 * 抽出来的原因：首屏不再让客户端水合后再请求一次同样的数据，
 * 服务端直接渲染最近时间线；轮询仍复用同一份组装逻辑，避免两处漂移。
 */
export function loadHomeData(
  db: Db,
  userId: string,
  opts: HomeDataOptions,
): HistoryResponse {
  const mode = opts.mode;
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  // P12：聊天模式用「聊天会长」（未设置则跟随任务会长）；任务模式用任务会长
  const currentMasterId =
    mode === "chat" ? getChatMasterId(db, userId) : (save?.activeMasterId ?? null);
  let currentMasterName = "会长";
  let currentMasterAvatar: string | null = null;
  let currentMasterSprite: string | null = null;
  if (currentMasterId) {
    const master = db
      .select()
      .from(masters)
      .where(eq(masters.id, currentMasterId))
      .get();
    if (master) {
      currentMasterName = master.name;
      currentMasterAvatar = master.avatar ?? null;
      currentMasterSprite = master.sprite ?? null;
    }
  }

  // P10 聊天模式：确定会话（指定 → 校验归属；否则取/建活跃会话）
  let sessionId: string | null = null;
  let sessions: ReturnType<typeof listSessions> = [];
  if (mode === "chat" && currentMasterId) {
    const requested = opts.sessionId;
    const wanted = requested ? getSession(db, userId, requested) : null;
    sessionId =
      wanted && wanted.masterId === currentMasterId
        ? wanted.id
        : ensureActiveSession(db, userId, currentMasterId);
    ensureChatGreeting(db, userId, sessionId);
    sessions = listSessions(db, userId, currentMasterId);
  }

  const windowStart = chatWindowStart();
  // 聊天模式：按会话取历史（不受三天窗口限制，否则老会话点进去一片空白），
  // 支持 before 游标向前翻页；任务模式仍只看最近三个自然日。
  const chatBefore = opts.before != null && opts.before > 0 ? opts.before : null;
  // 增量轮询（?since=<ms>）：生成在途时前端每 2.5s 拉一次，只回新落库的内容，
  // 避免把 200~300 条带正文的消息反复下发。
  const since = opts.since != null && opts.since > 0 ? opts.since : null;
  const incremental = since != null;
  const CHAT_PAGE = 200;
  const { items, hasMore, nextBefore } = queryRecords(db, userId, {
    ...(mode === "chat"
      ? {
          before: chatBefore,
          ...(since != null ? { since } : {}),
          limit: incremental ? MAX_INCREMENTAL : CHAT_PAGE,
        }
      : {
          since: Math.max(windowStart, since ?? 0),
          limit: incremental ? MAX_INCREMENTAL : 300,
        }),
    mode,
    sessionId,
    // 任务流：只看当前会长的主线；结算卡片仍全局（本查询的 settlement 分支不过滤）
    masterId: mode === "quest" ? (save?.activeMasterId ?? null) : null,
  });
  // 主界面按时间正序渲染
  items.reverse();

  const messages = items.filter(
    (it): it is Extract<RecordItem, { type: "message" }> => it.type === "message",
  );
  const settlements = items.filter(
    (it): it is Extract<RecordItem, { type: "settlement" }> => it.type === "settlement",
  );

  // 配图状态批量取：一次 SQL + 一次目录扫描，供下面逐条消息使用
  const sceneJobs = activeSceneJobs(db);
  const sceneFiles = listSceneFiles();

  let masterSprite: unknown = null;
  if (currentMasterSprite) {
    try {
      masterSprite = JSON.parse(currentMasterSprite);
    } catch {
      masterSprite = null;
    }
  }

  return {
    mode,
    masterName: currentMasterName,
    // 本地生图开关（关闭时前台不显示「给这一幕配图」按钮）
    imageEnabled: getImageConfig(db).enabled,
    masterAvatar: assetUrl("avatar", currentMasterAvatar),
    masterSprite: masterSprite as HistoryResponse["masterSprite"],
    background: assetUrl(
      "background",
      sessionId ? getSession(db, userId, sessionId)?.scene : null,
    ),
    // P12：聊天模式返回聊天会长（前端开场白编辑等用），任务模式返回任务会长
    activeMasterId: currentMasterId,
    windowStart,
    // 增量轮询只回时间线增量与在途状态；会话列表/开场白/更早游标等静态字段省略，
    // 既少查库也少下发（前端只在字段存在时更新对应 state）。
    ...(incremental
      ? { incremental: true }
      : {
          // 任务模式用三天窗口判定是否有更早内容（走 /records 归档）；
          // 聊天模式用会话内分页游标（下一页的 before，null = 没有更早的了）。
          hasEarlier:
            mode === "chat"
              ? hasMore
              : hasRecordsBefore(
                  db,
                  userId,
                  windowStart,
                  mode,
                  sessionId,
                  save?.activeMasterId ?? null,
                ),
          nextBefore: mode === "chat" ? nextBefore : null,
          sessions,
          ...(mode === "chat" && sessionId
            ? { greeting: chatGreetingOptions(db, userId, sessionId) }
            : {}),
        }),
    messages: messages.map((m) => {
      // 配图状态一次查询 + 一次目录扫描（见 activeSceneJobs / listSceneFiles），
      // 不再对每条消息各查一次数据库、各 stat 一次文件。
      const job = sceneJobs.get(m.id);
      const imageFile = sceneFiles.get(m.id) ?? null;
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        sender: m.sender,
        createdAt: m.createdAt,
        // 本地生图：该消息若已配图则给出 URL（文件在 data/scenes/<消息id>.<ext>）
        image: assetUrl("scene", imageFile),
        // 后台是否正在为该消息生成配图（前台刷新/重进后据此恢复「正在作画」）
        generating: !!job,
        generatingSince: job?.startedAt,
      };
    }),
    settlements: settlements.map((s) => s.settlement),
    // P10 当前会话 id（增量轮询也要回，前端用它确认没有切走）
    sessionId,
    // 该 mode/会话是否仍有生成在途（切页回来恢复「正在回复」用）
    // 作用域与 POST 一致：聊天=会话，任务=当前会长
    pending: isPending(
      pendingKey(userId, mode, mode === "chat" ? sessionId : (save?.activeMasterId ?? null)),
      db,
    ),
  };
}
