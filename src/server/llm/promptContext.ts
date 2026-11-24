import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { Db } from "../db";
import { chatLog, masters, quests, saves, settlementLog } from "../db/schema";
import { getCharacterSummary } from "../character";
import { startOfToday } from "../util/time";
import { parseCard } from "../cards";
import { getAffinity, getChatMasterId } from "../masters";
import { loadMemories, loadMemoriesForScope } from "../memory";
import { getWeeklyBossState } from "../weeklyBoss";
import { getUserPersona, buildUserPersonaLayer } from "../userPersona";
import { modelFromDb } from "../modelConfig";
import {
  createDeepSeekReviewer,
  createMemoryExtractor,
  createMemoryReviewer,
  type MemoryExtractor,
  type MemoryReviewer,
  type SettlementReviewer,
} from "./reviewer";
import type { ChatPromptContext, QuestBrief, SettlementBrief } from "./prompts";

/** 对话历史注入条数（最近 20 条消息，约 10 轮） */
const HISTORY_LIMIT = 20;

/**
 * 组装系统提示词所需上下文（任务 / 聊天两种管线）。
 *
 * 从 conversation.ts 抽出：这两个函数只读数据库、不参与编排，
 * 单独放置便于阅读，也避免对话主循环文件继续膨胀。
 */

/** 记忆复核用的近端上下文：最近几条消息的纯文本摘要 */
export function recentContext(messages: ModelMessage[]): string {
  return messages
  .slice(-6)
  .map((m) => {
  const who = m.role === "user" ? "用户" : m.role === "assistant" ? "会长" : m.role;
  const text =
  typeof m.content === "string"
  ? m.content
  : JSON.stringify(m.content).slice(0, 160);
  return who + ": " + text.slice(0, 200);
  })
  .join("\n");
}

/** 本轮工具调用中产生的复核目标（结算 → settlementId；异议 → disputeId） */
export interface ReviewTarget {
  settlementId: string;
  disputeId?: string;
}

export function insertChat(
  db: Db,
  userId: string,
  role: "user" | "master" | "system",
  content: string,
  masterId?: string,
  mode: "quest" | "chat" = "quest",
  sessionId?: string | null,
): string {
  const id = randomUUID();
  db.insert(chatLog)
  .values({
    id,
    userId,
    role,
    content,
    masterId: masterId ?? null,
    mode,
    sessionId: sessionId ?? null,
    createdAt: Date.now(),
  })
  .run();
  return id;
}

/** 组装五层系统提示词所需的全部上下文（全部来自 DB 查询） */
export function loadPromptContext(db: Db, userId: string) {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save?.activeMasterId) {
  throw new Error("存档或会长缺失，请先完成初始化");
  }
  const master = db
  .select()
  .from(masters)
  .where(eq(masters.id, save.activeMasterId))
  .get();
  if (!master) throw new Error(`会长不存在：${save.activeMasterId}`);
  const persona = parseCard(master.personaJson);

  // 记忆层：按类别取最近 N 条（P12：只取当前会长的记忆书）
  const memories = loadMemories(db, userId, master.id);

  const activeRows = db
  .select()
  .from(quests)
  .where(and(eq(quests.userId, userId), eq(quests.status, "active")))
  .all();
  const activeQuests: QuestBrief[] = activeRows.map((q) => {
  const brief: QuestBrief = {
  title: q.title,
  type: q.type,
  status: q.status,
  streak: q.streak,
  difficulty: q.difficulty,
  };
  // V2.0 主线：附里程碑进度（提示词状态层显示「主线，里程碑 2/5」）
  if (q.type === "mainline") {
  const kids = db
  .select({ status: quests.status })
  .from(quests)
  .where(eq(quests.parentQuestId, q.id))
  .all();
  brief.milestone = {
  done: kids.filter((k) => k.status === "completed").length,
  total: kids.length,
  };
  }
  return brief;
  });

  const character = getCharacterSummary(db, userId);

  const todaySettlements: SettlementBrief[] = db
  .select({
  questTitle: quests.title,
  xpAwarded: settlementLog.xpAwarded,
  goldAwarded: settlementLog.goldAwarded,
  })
  .from(settlementLog)
  .leftJoin(quests, eq(settlementLog.questId, quests.id))
  .where(
  and(
  eq(settlementLog.userId, userId),
  eq(settlementLog.kind, "quest_complete"),
  gte(settlementLog.createdAt, startOfToday()),
  ),
  )
  .all();

  const userPersona = getUserPersona(db);
  return {
  masterId: master.id,
  masterName: master.name,
  persona,
  // P11：任务模式的关系阶段取「当前会长」的亲密度（每会长一份）
  intimacyStage: getAffinity(db, userId, master.id).stage,
  memories,
  activeQuests,
  character,
  todaySettlements,
  // P9 冒险者卡：用户自己的设定（两模式共用）
  userPersona: buildUserPersonaLayer(userPersona),
  userName: userPersona.name,
  // V3 周常 Boss：本周悬赏与进度（提示词状态层显示）
  weeklyBoss: (() => {
  const s = getWeeklyBossState(db, userId);
  return {
  name: s.boss.name,
  desc: s.boss.desc,
  progress: s.progress,
  target: s.boss.target,
  claimed: s.claimed,
  };
  })(),
  // M5 冷启动：未标记完成时注入第三幕剧本
  isOnboarding: save.onboardedAt == null,
  };
}

/**
 * 聊天模式的提示词上下文（P0/P12）：会长卡 + 记忆书 + 冒险者卡，
 * 不查委托/结算/周常/每日事件（那些属于任务管线）。
 * P12：聊天用「聊天会长」（saves.chat_master_id ?? active_master_id）；
 * 记忆 = 该会长的永久记忆 + 当前这段对话的私有记忆（各对话互不共享）。
 */
export function loadChatPromptContext(
  db: Db,
  userId: string,
  sessionId?: string | null,
): ChatPromptContext {
  const masterId = getChatMasterId(db, userId);
  if (!masterId) {
    throw new Error("存档或会长缺失，请先完成初始化");
  }
  const master = db
  .select()
  .from(masters)
  .where(eq(masters.id, masterId))
  .get();
  if (!master) throw new Error(`会长不存在：${masterId}`);
  const userPersona = getUserPersona(db);
  return {
  masterName: master.name,
  persona: parseCard(master.personaJson),
  memories: loadMemoriesForScope(db, userId, master.id, sessionId ?? null),
  userPersona: buildUserPersonaLayer(userPersona),
  userName: userPersona.name,
  };
}

export function loadHistory(
  db: Db,
  userId: string,
  mode: "quest" | "chat" = "quest",
  sessionId?: string | null,
  masterId?: string | null,
): ModelMessage[] {
  // 聊天模式：限定会话（P10）；任务模式：限定当前会长（会长各有一条主线）
  const conditions = [
  eq(chatLog.userId, userId),
  eq(chatLog.mode, mode),
  inArray(chatLog.role, ["user", "master"]),
  ];
  if (mode === "chat" && sessionId) {
  conditions.push(eq(chatLog.sessionId, sessionId));
  }
  if (mode === "quest" && masterId) {
  conditions.push(eq(chatLog.masterId, masterId));
  }
  const rows = db
  .select()
  .from(chatLog)
  .where(and(...conditions))
  .orderBy(desc(chatLog.createdAt))
  .limit(HISTORY_LIMIT)
  .all()
  .reverse();
  return rows.map((r) => ({
  role: r.role === "user" ? ("user" as const) : ("assistant" as const),
  content: r.content,
  }));
}


/** 结算复核判定器（无 Key 时静默关闭，结算主链路不受影响） */
export function defaultReviewer(db: Db): SettlementReviewer | null {
  try {
    // 判定器独立选型（llm.judge_model，未配置则跟随主模型）
    return createDeepSeekReviewer(modelFromDb(db, "judge"));
  } catch {
    return null;
  }
}

/** 记忆复核判定器（无 Key 时行为回退为直接入库） */
export function defaultMemoryReviewer(db: Db): MemoryReviewer | null {
  try {
    return createMemoryReviewer(modelFromDb(db, "judge"));
  } catch {
    return null;
  }
}

/** 聊天记忆抽取器（无 Key 时本轮不产生新记忆） */
export function defaultMemoryExtractor(db: Db): MemoryExtractor | null {
  try {
    return createMemoryExtractor(modelFromDb(db, "judge"));
  } catch {
    return null;
  }
}
