import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { Db } from "../db";
import {
  saves,
  masters,
  memory,
  quests,
  character,
  chatLog,
  settlementLog,
  chatSessions,
} from "../db/schema";
import { getCharacterSummary, getSettlementsSince, type SettlementRecord } from "../character";
import { modelFromDb } from "../modelConfig";
import { startOfToday } from "../util/time";
import { countActiveQuests } from "../cron/jobs";
import { config, type AttrKey } from "../engine/config";
import { checkinReward } from "../engine/checkin";
import { applyRankPromotion } from "../rankPromotion";
import { getSkillModifiers } from "../skills";
import { evaluateAchievements, type AchievementDef } from "../achievements";
import { getWeeklyBossState, maybeClaimWeeklyBoss } from "../weeklyBoss";
import { dailyEventNarrative, rollDailyEvent } from "../dailyEvent";
import {
  TOOL_DEFINITIONS,
  createToolContext,
  executeToolArgs,
  type ToolContext,
} from "./tools";
import {
  createDeepSeekReviewer,
  createMemoryReviewer,
  createMemoryExtractor,
  type SettlementReviewer,
  type MemoryReviewer,
  type MemoryExtractor,
} from "./reviewer";
import { runSettlementReview } from "../reviewPipeline";
import { parseCard, deriveGreeting, allGreetings } from "../cards";
import { getAffinity, getChatMasterId } from "../masters";
import { loadMemories, loadMemoriesForScope, saveExtractedMemories } from "../memory";
import { sessionHasUserMessage, touchSession } from "../chatSessions";
import { activateWorldBook, listWorldBookEntries } from "../worldbook";
import { getRpSettings } from "../rp";
import { getUserPersona, buildUserPersonaLayer } from "../userPersona";
import {
  buildSystemPrompt,
  buildChatPrompt,
  buildStateLayer,
  expandReplyMacros,
  type PersonaJson,
  type QuestBrief,
  type SettlementBrief,
  type ChatPromptContext,
} from "./prompts";

const HISTORY_LIMIT = 20; // 最近 20 轮 chat_log
const MAX_TOOL_ROUNDS = 5; // 单轮对话工具调用循环上限（防失控）
const LLM_CALL_TIMEOUT_MS = 200_000; // 单次模型调用超时（长回复/供应商挂死兜底）

/** AbortSignal.timeout 触发的超时（DOMException name=TimeoutError/AbortError） */
function isTimeoutError(e: unknown): boolean {
  return (
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
  );
}

export interface ToolSummary {
  name: string;
  ok: boolean;
  summary: string;
}

export interface CeremonyEvent {
  type: "level_up" | "rank_up";
  scope?: string;
  from: string | number;
  to: string | number;
  gold?: number;
  /** 突破礼物品（rank_up 时由引擎写入） */
  items?: { name: string; count: number }[];
}

export interface ConversationResult {
  replyText: string;
  toolSummaries: ToolSummary[];
  /** 本轮是否有游戏状态变更（前端据此刷新面板） */
  stateChanged: boolean;
  /** 结算产生的状态变更摘要（如 +XP/+金币），供前端展示提示条；数据全部来自 DB/引擎 */
  settlementNotices: string[];
  /** V1.7 全屏仪式事件（升级/评级晋升；rank_up 优先） */
  ceremony?: CeremonyEvent;
  /** V2.0 本轮落账的结算记录（对话时间线卡片流；数据来自 settlement_log） */
  settlements: SettlementRecord[];
  /** V2.0 对账提醒等非结算提示（前端提示条显示） */
  reminderNotices: string[];
  /** 本轮落库的用户 / 会长消息 id（前端用真实 id 做生图、删除等，避免本地假 id） */
  userMessageId: string;
  masterMessageId: string;
}

/**
 * 流式事件（route 转发给前端 SSE）。
 * - delta：模型新增的一段正文；
 * - reset：本轮其实是工具调用轮，先前 delta 出来的文字作废，请清掉重来。
 */
export type ConversationStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reset" };

export interface ConversationOptions {
  /** LLM 底座模型；默认从环境变量组装 DeepSeek（client.ts）。测试注入 mock model */
  model?: LanguageModel;
  /**
   * 流式回调。传了就用 streamText 并把增量文本交给它（route 用来转发 SSE）；
   * 不传（测试/批处理）则沿用 generateText，行为与旧版一致。
   */
  onEvent?: (e: ConversationStreamEvent) => void;
  /** 工具执行上下文（跟踪 create_quest 属性越界打回次数） */
  toolContext?: ToolContext;
  /** V3 每日事件掷骰随机源（测试注入固定序列；默认 Math.random） */
  dailyRand?: () => number;
  /**
  * 结算复核判定器（V1.5）。undefined = 默认 DeepSeek 判定器（无 key 时自动
  * 关闭复核，fail-open）；null = 显式禁用（测试用）。
  */
  reviewer?: SettlementReviewer | null;
  /**
  * 记忆复核判定器（V1.7）：把关 add_memory 的内容。undefined = 默认
  * （走判定模型，无 key 自动关闭）；null = 显式禁用。
  */
  memoryReviewer?: MemoryReviewer | null;
  /**
   * P12 聊天记忆抽取器：每轮后台从对话里抽取长期记忆。undefined = 默认
   * （走判定模型，无 key 自动关闭）；null = 显式禁用。
   */
  memoryExtractor?: MemoryExtractor | null;
}

function defaultReviewer(db: Db): SettlementReviewer | null {
  try {
  // 判定器独立选型（llm.judge_model，未配置则跟随主模型）
  return createDeepSeekReviewer(modelFromDb(db, "judge"));
  } catch {
  // 无 API Key（面板设置与环境变量都没有）：复核静默关闭，结算主链路不受影响
  return null;
  }
}

function defaultMemoryReviewer(db: Db): MemoryReviewer | null {
  try {
  return createMemoryReviewer(modelFromDb(db, "judge"));
  } catch {
  // 无 Key：记忆复核静默关闭（行为回退为直接入库）
  return null;
  }
}

function defaultMemoryExtractor(db: Db): MemoryExtractor | null {
  try {
  return createMemoryExtractor(modelFromDb(db, "judge"));
  } catch {
  // 无 Key：聊天记忆抽取静默关闭（本轮不产生新记忆）
  return null;
  }
}

/** 记忆复核用的近端上下文：最近几条消息的纯文本摘要 */
function recentContext(messages: ModelMessage[]): string {
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
interface ReviewTarget {
  settlementId: string;
  disputeId?: string;
}

function insertChat(
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

function loadHistory(
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

/**
 * TOOL_DEFINITIONS → AI SDK ToolSet。
 * 工具只带 schema 不带 execute：执行权保留在本项目的 executeToolArgs
 * （摘要落库、前端刷新信号、复核钩子都依赖执行过程），AI SDK 仅负责
 * 协议与校验，编排不交给框架。
 */
export function buildToolSet(): ToolSet {
  const set: ToolSet = {};
  for (const def of TOOL_DEFINITIONS) {
  set[def.function.name] = tool({
  description: def.function.description,
  inputSchema: jsonSchema<Record<string, unknown>>(
  def.function.parameters as Parameters<typeof jsonSchema>[0],
  ),
  // 不带 execute：工具执行权保留在本项目的 executeToolArgs
  });
  }
  return set;
}

/**
 * 对话主循环：
 * 五层系统提示词 + 最近 20 轮 chat_log + 用户新消息 → LLM →
 * 有 tool_calls 则逐个执行、结果回注 → LLM 生成最终叙事文本。
 * 每轮以 stopWhen(stepCountIs(1)) 单步驱动，工具循环仍由本函数掌控。
 */
export async function runConversation(
  db: Db,
  userId: string,
  userMessage: string,
  opts: ConversationOptions = {},
): Promise<ConversationResult> {
  // V2.0 本轮起点：早于签到自动结算，保证本轮所有留痕都被卡片流捞到
  const turnStart = Date.now();
  // 本轮全部 chat_log 留痕的 id：任一环节失败则整体回滚，
  // 避免"模型报错→前端还原输入→用户重发"时同一条用户消息入库两次。
  const turnChatIds: string[] = [];
  const insertTurnChat = (
    role: "user" | "master" | "system",
    content: string,
    masterId?: string,
  ): string => {
    const id = insertChat(db, userId, role, content, masterId);
    turnChatIds.push(id);
    return id;
  };
  const rollbackTurn = () => {
    if (turnChatIds.length === 0) return;
    db.delete(chatLog).where(inArray(chatLog.id, turnChatIds)).run();
  };
  const promptCtx = loadPromptContext(db, userId);
  const questHistory = loadHistory(db, userId, "quest", undefined, promptCtx.masterId);
  // 任务模式不注入世界书：世界书是酒馆式 RP 的东西，混进任务线会出戏。
  // （聊天模式仍在 buildChatPrompt 里按激活注入世界书/R18。）
  // 稳定前缀：只含指令/人设/记忆等低频变化的内容，作为 system 参数。
  // 易变的状态层与动态事件挪到历史之后（见下），以保证 system + 历史 成为可缓存的相同前缀。
  const stableSystemPrompt = buildSystemPrompt(promptCtx, { excludeState: true });
  const stateBlock = buildStateLayer(
  promptCtx.activeQuests,
  promptCtx.character,
  promptCtx.todaySettlements,
  promptCtx.weeklyBoss,
  );
  // 轮首易变上下文（状态层 + 开场前产生的动态事件/签到）；定稿后写入 messages
  const turnNotes: string[] = [];
  const messages: ModelMessage[] = [];
  let messagesBuilt = false;
  // 工具结果回注前，系统注记先缓冲：AI SDK 要求 tool-result 紧跟在 tool-call 之后
  let pendingRoundNotes: string[] | null = null;
  /** 追加一段仅供本轮模型参考的 system 上下文（不落库、不污染历史） */
  const addSystemNote = (text: string) => {
  if (!messagesBuilt) turnNotes.push(text);
  else if (pendingRoundNotes) pendingRoundNotes.push(text);
  else messages.push({ role: "system", content: text });
  };

  const userMessageId = insertTurnChat("user", userMessage, promptCtx.masterId);

  // 模型在落库后解析：面板「模型设置」优先，环境变量兜底；
  // 都没有 Key 时行为与之前一致（消息已留痕，路由返回 503 引导去设置页）
  let model: LanguageModel;
  try {
    model = opts.model ?? modelFromDb(db);
  } catch (e) {
    rollbackTurn(); // 构造模型就失败：本轮什么都没发生，回滚留痕
    throw e;
  }
  const toolCtx = opts.toolContext ?? createToolContext();
  const reviewer =
  opts.reviewer !== undefined ? opts.reviewer : defaultReviewer(db);
  const memoryReviewer =
  opts.memoryReviewer !== undefined
  ? opts.memoryReviewer
  : defaultMemoryReviewer(db);

  const toolSummaries: ToolSummary[] = [];
  const settlementNotices: string[] = [];
  const reminderNotices: string[] = [];
  let stateChanged = false;
  let ceremony: CeremonyEvent | undefined;
  // V3 被动技能修正（签到加成等）
  const skillMods = getSkillModifiers(db, userId);

  /**
   * V3 成就：评估 → 发奖（titles + settlement_log）→ 注入叙事指令 + 提示条。
   * 轮开始与结算成功后各调一次，保证"这一轮新达成的成就"也能被会长当场提到。
   */
  const announceAchievements = (newly: AchievementDef[]) => {
    if (newly.length === 0) return;
    for (const a of newly) {
      reminderNotices.push(`成就解锁：「${a.name}」`);
      insertTurnChat("system", `[成就] 解锁「${a.name}」：${a.desc}`);
    }
    const list = newly.map((a) => `「${a.name}」（${a.desc}）`).join("、");
    addSystemNote(`【成就】你刚刚为冒险者授了成就：${list}。挑其中一件用你的语气提一句，不要复述数值，也不要一次报全部。`);
  };
  announceAchievements(evaluateAchievements(db, userId));

  /** V3 周常 Boss：达标即发奖（每周一次），并注入叙事指令 + 提示条 */
  const announceWeeklyBoss = () => {
    const claim = maybeClaimWeeklyBoss(db, userId);
    if (!claim) return;
    reminderNotices.push(`周常讨伐达成：「${claim.boss.name}」奖励已入袋`);
    insertTurnChat("system", `[周常] 达成「${claim.boss.name}」：${claim.boss.desc}`);
    addSystemNote(`【周常讨伐】本周悬赏「${claim.boss.name}」已经达成，奖励也入袋了。用一句你的话收个尾，别提具体数字。`);
  };
  announceWeeklyBoss();

  /**
   * V3 每日随机事件：当天首次对话掷骰（已存在则沿用），命中才播报。
   * 效果（打折/金币加成/首笔 XP）由商店与结算各自读取，这里只负责叙事。
   */
  const dailyRoll = rollDailyEvent(db, userId, new Date(), opts.dailyRand);
  if (dailyRoll.event && dailyRoll.fresh) {
    const narrative = dailyEventNarrative(dailyRoll.event);
    reminderNotices.push(`今日事件 · ${narrative}`);
    insertTurnChat("system", `[每日事件] ${narrative}`);
    addSystemNote(`【每日事件】今天协会里发生了一件小事——${narrative}。开场自然地带一句，别提具体数值。`);
  }

  // V1.8 每日签到：当日第一条消息进门，
  // 引擎自动结算 active 的签到委托——不问内容、不走判定器。
  // DESIGN-DECISION: 这是"LLM 是翻译层不是账本"的正例示范——结算完全由引擎
  // 完成（平基准 + 留痕 + 晋升补发），会长只负责开场叙事化反应。
  if (config.checkin_base) {
  const dayStart = startOfToday();
  const dueCheckins = db
  .select()
  .from(quests)
  .where(
  and(
  eq(quests.userId, userId),
  eq(quests.status, "active"),
  eq(quests.type, "daily"),
  eq(quests.checkin, 1),
  ),
  )
  .all();
  for (const q of dueCheckins) {
  const alreadyToday = db
  .select({ id: settlementLog.id })
  .from(settlementLog)
  .where(
  and(
  eq(settlementLog.questId, q.id),
  eq(settlementLog.kind, "quest_complete"),
  gte(settlementLog.createdAt, dayStart),
  ),
  )
  .all();
  if (alreadyToday.length > 0) continue;

  const reward = checkinReward({
  primaryAttr: q.primaryAttr as AttrKey,
  primaryWeight: q.primaryWeight,
  secondaryAttr: (q.secondaryAttr ?? null) as AttrKey | null,
  secondaryWeight: q.secondaryWeight,
  }, skillMods.checkinBonusRatio);

  const charRow = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (!charRow) continue;
  const current = charRow as unknown as Record<string, number>;
  const updates: Record<string, number> = {
  totalXp: current.totalXp + reward.xp,
  gold: current.gold + reward.gold,
  };
  for (const [attr, delta] of Object.entries(reward.attrSplit)) {
  updates[`${attr}Xp`] = (current[`${attr}Xp`] ?? 0) + delta;
  }
  const promotion = applyRankPromotion(
  db,
  userId,
  current.totalXp,
  updates.totalXp,
  q.id,
  "每日签到 XP 触发评级晋升",
  );
  updates.gold += promotion.gold;

  db.update(character)
  .set(updates as Partial<typeof character.$inferInsert>)
  .where(eq(character.userId, userId))
  .run();
  db.update(quests)
  .set({ streak: q.streak + 1, breakStreak: 0 })
  .where(eq(quests.id, q.id))
  .run();
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId: q.id,
  kind: "quest_complete",
  completionRatio: 1,
  confidence: 1,
  xpAwarded: reward.xp,
  goldAwarded: reward.gold,
  attrSplitJson: JSON.stringify(reward.attrSplit),
  adjustmentsJson: null,
  llmReasoning: "每日签到（引擎自动结算，到场奖励）",
  createdAt: Date.now(),
  })
  .run();

  settlementNotices.push(`签到「${q.title}」：+${reward.xp} XP，+${reward.gold} 金币`);
  stateChanged = true;
  addSystemNote(`【签到】用户一进门，今日的「${q.title}」签到已自动办妥（到场奖励，不算战果汇报，数值不要复述）。开场可以自然带一句。`);
  }
  }

  // 上下文定稿：历史 → 轮首易变上下文（状态层 + 动态事件/签到）→ 用户消息。
  // system 参数（stableSystemPrompt）不含这些易变内容，故与本轮之前的请求共享
  // 「system + 历史」这段相同前缀，支持前缀缓存的模型/网关即可命中，省 token、降首字延迟。
  messages.push(
  ...questHistory,
  { role: "system", content: [stateBlock, ...turnNotes].filter(Boolean).join("\n\n") },
  { role: "user", content: userMessage },
  );
  messagesBuilt = true;

  let replyText = "";
  // 工具集只依赖 TOOL_DEFINITIONS（模块常量），提出循环外只构建一次
  const tools = buildToolSet();
  // V1.7 完整性加固：本轮是否真的结算过（对账提醒的判据之一）
  let settledThisTurn = false;

  /** 单轮模型调用（流式或一次性）：拿到正文、工具调用与回注消息 */
  const callModel = async (): Promise<{
  text: string;
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
  responseMessages: ModelMessage[];
  }> => {
  const abortSignal = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS);
  if (opts.onEvent) {
  // 流式：边生成边把增量文本推给前端；本轮若其实是工具调用，先前文字作废（发 reset）
  const stream = streamText({
  model,
  system: stableSystemPrompt,
  messages,
  tools,
  toolChoice: "auto",
  stopWhen: stepCountIs(1),
  abortSignal,
  // 允许在 messages 中间放 system 上下文（状态层/复核结论），
  // 这样稳定的 system + 历史 才能构成可缓存的相同前缀
  allowSystemInMessages: true,
  });
  let streamed = false;
  for await (const part of stream.stream) {
  if (part.type === "text-delta") {
  streamed = true;
  opts.onEvent({ type: "delta", text: part.text });
  } else if (part.type === "error") {
  throw part.error;
  }
  }
  const toolCalls = (await stream.toolCalls).map((c) => ({
  toolCallId: c.toolCallId,
  toolName: c.toolName,
  input: c.input,
  }));
  const responseMessages = (await stream.responseMessages) as ModelMessage[];
  const text = await stream.text;
  if (toolCalls.length > 0 && streamed) opts.onEvent({ type: "reset" });
  return { text, toolCalls, responseMessages };
  }
  const result = await generateText({
  model,
  system: stableSystemPrompt,
  messages,
  tools,
  toolChoice: "auto",
  stopWhen: stepCountIs(1),
  abortSignal,
  allowSystemInMessages: true,
  });
  return {
  text: result.text,
  toolCalls: result.toolCalls.map((c) => ({
  toolCallId: c.toolCallId,
  toolName: c.toolName,
  input: c.input,
  })),
  responseMessages: result.responseMessages as ModelMessage[],
  };
  };

  /** 单轮：一次模型调用 + 工具执行 + 复核钩子。返回叙事文本（未调工具时） */
  const runRound = async (): Promise<{ text: string; hadToolCalls: boolean }> => {
  try {
  const { text, toolCalls, responseMessages } = await callModel();

  if (toolCalls.length === 0) {
  return { text, hadToolCalls: false };
  }

  // 回注 assistant 的 tool_calls 消息
  messages.push(...responseMessages);

  // 本轮的注记先缓冲，等 tool-result 回注后再落，避免打断 tool-call→tool-result 的相邻关系
  pendingRoundNotes = [];

  // 执行工具并回注结果（编排/留痕/信号由本项目掌控，不交给框架）
  const resultParts = [];
  const reviewTargets: ReviewTarget[] = [];
  for (const call of toolCalls) {
  const toolResult = executeToolArgs(
  db,
  userId,
  call.toolName,
  call.input as Record<string, unknown>,
  toolCtx,
  );
  toolSummaries.push({
  name: call.toolName,
  ok: toolResult.ok,
  summary: toolResult.summary,
  });
  if (toolResult.stateChanged) stateChanged = true;
  if (call.toolName === "settle_completion" && toolResult.ok) {
  settlementNotices.push(toolResult.summary);
  settledThisTurn = true;
  // V1.7 仪式事件：rank_up 优先于 level_up（一轮内同时发生时取更隆重的）
  const settleData = toolResult.data as {
  level_ups?: { scope: string; from: number; to: number }[];
  rank_up?: {
  from: string;
  to: string;
  gold: number;
  items?: { name: string; count: number }[];
  } | null;
  };
  if (settleData.rank_up) {
  ceremony = {
  type: "rank_up",
  from: settleData.rank_up.from,
  to: settleData.rank_up.to,
  gold: settleData.rank_up.gold,
  items: settleData.rank_up.items,
  };
  } else if (settleData.level_ups?.length && ceremony?.type !== "rank_up") {
  const t = settleData.level_ups.find((l) => l.scope === "total") ?? settleData.level_ups[0];
  ceremony = { type: "level_up", scope: t.scope, from: t.from, to: t.to };
  }
  // V3 成就：本轮结算可能刚好达成（如"十件委托"）
  announceAchievements(evaluateAchievements(db, userId));
  // V3 周常 Boss：本轮结算可能刚好达标
  announceWeeklyBoss();
  }
  // V1.5 复核管线挂载点：结算成功 → 收获复核；异议登记 → 异议复核
  if (toolResult.ok) {
  const data = toolResult.data as {
  settlement_id?: string;
  dispute_id?: string;
  };
  if (call.toolName === "settle_completion" && data.settlement_id) {
  reviewTargets.push({ settlementId: data.settlement_id });
  }
  if (
  call.toolName === "file_dispute" &&
  data.dispute_id &&
  data.settlement_id
  ) {
  reviewTargets.push({
  settlementId: data.settlement_id,
  disputeId: data.dispute_id,
  });
  }
  }
  // V1.7 记忆复核：add_memory 乐观落库后由复核员把关（驳回即删、修正即改）
  if (call.toolName === "add_memory" && toolResult.ok && memoryReviewer) {
  const data = toolResult.data as {
  memory_id?: string;
  category?: string;
  content?: string;
  };
  if (data.memory_id && config.memory_review?.enabled !== false) {
  const verdict = await memoryReviewer
  .review({
  category: data.category ?? "",
  content: data.content ?? "",
  context: recentContext(messages),
  })
  .catch(() => null);
  if (verdict && verdict.action !== "keep") {
  if (verdict.action === "correct" && verdict.content) {
  db.update(memory).set({ content: verdict.content }).where(eq(memory.id, data.memory_id)).run();
  insertTurnChat("system", `[记忆复核] 修正：${verdict.reason}`);
  addSystemNote(`【记忆复核】你刚记下的记忆已被修正为：「${verdict.content}」。理由：${verdict.reason}。`);
  } else if (verdict.action === "discard") {
  db.delete(memory).where(eq(memory.id, data.memory_id)).run();
  insertTurnChat("system", `[记忆复核] 驳回：${verdict.reason}`);
  addSystemNote(`【记忆复核】你刚想记下的记忆被驳回了（${verdict.reason}）。不要向用户提起这条记忆。`);
  }
  }
  }
  }
  // 工具调用摘要作为 system 记录落库
  insertTurnChat(
  "system",
  `[工具] ${call.toolName} → ${toolResult.ok ? "成功" : "失败"}：${toolResult.summary}`,
  );
  resultParts.push({
  type: "tool-result" as const,
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: { type: "text" as const, value: JSON.stringify(toolResult.data) },
  });
  }
  messages.push({ role: "tool", content: resultParts });
  // 注记落位：紧跟 tool-result 之后（可缓存的 system+历史 仍在更前面，不受影响）
  for (const note of pendingRoundNotes) messages.push({ role: "system", content: note });
  pendingRoundNotes = null;

  // 复核（不占工具轮次）：判定器 → 引擎护栏 → 落账 → 注入叙事指令
  if (reviewer) {
  for (const target of reviewTargets) {
  const outcome = await runSettlementReview(db, userId, target.settlementId, {
  reviewer,
  disputeId: target.disputeId,
  });
  if (outcome.applied) stateChanged = true;
  if (outcome.notice) settlementNotices.push(outcome.notice);
  if (outcome.systemMessage) {
  addSystemNote(outcome.systemMessage);
  }
  }
  }
  return { text: "", hadToolCalls: true };
  } catch (e) {
  // 超时：走兜底文本，已执行的结算/留痕不受影响
  // 单轮调用 200s 超时：供应商挂死时不永久阻塞路由。
  // Key 无效等其他错误照常抛给路由层（500 带原因）
  if (isTimeoutError(e)) return { text: "", hadToolCalls: false };
  // 其他失败：回滚本轮 chat_log 留痕，前端重发不会重复入库
  rollbackTurn();
  throw e;
  }
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const r = await runRound();
  if (!r.hadToolCalls) {
  replyText = r.text;
  break;
  }
  }

  // V1.7 对账提醒：用户的话像战果汇报、会长却没调结算工具 → 注入提醒并给一次补账回合。
  // DESIGN-DECISION: 提醒是"若确属汇报请补结算，否则忽略"的软指令——判定权仍在会长，
  // 引擎护栏（置信度/同日/状态机）照常兜底，不存在被提醒绑架的误结算路径。
  const looksLikeReport =
  /交差|完成了|做完了|干完了|搞定了|汇报|超额|跑完|背完|读完|写完|录完|画完/.test(userMessage);
  const replyAsks = /[？?]/.test(replyText);
  if (
  replyText &&
  !settledThisTurn &&
  !replyAsks &&
  looksLikeReport &&
  countActiveQuests(db, userId) > 0
  ) {
  const nudge =
  "【对账提醒】用户刚才的话像是一份战果汇报，但这一轮你没有调用 settle_completion。若确属汇报，立即调用工具补结算；若不是汇报或还缺细节，忽略本条，正常回话。";
  addSystemNote(nudge);
  const nudged = await runRound();
  if (nudged.hadToolCalls) {
  // 补结算成功后再要一段收尾叙事
  const final = await runRound();
  replyText = final.text || nudged.text;
  if (replyText) {
  reminderNotices.push("有一笔战果刚才漏记了，已经补上。");
  }
  } else if (nudged.text) {
  replyText = nudged.text;
  // 会长坚持不记（可能确非汇报）：给用户一条可见的对账提示
  reminderNotices.push("有一笔战果似乎没记上？跟会长确认一下。");
  }
  }

  if (!replyText) {
  // 达到工具轮次上限仍无文本回复：兜底，不编造叙事
  replyText = "（会长提笔想了很久，又把纸揉掉了。请再说一次？）";
  }

  replyText = sanitizeReply(replyText);
  // 清掉模型照抄出来的卡宏（{{user}}/{{char}} 等）
  replyText = expandReplyMacros(replyText, promptCtx.masterName, promptCtx.userName);

  // V0.5.1 记录本条消息由哪位会长发送（换人后历史消息正确归属）
  const activeMaster = db.select().from(saves).where(eq(saves.userId, userId)).get();
  const masterMessageId = insertTurnChat("master", replyText, activeMaster?.activeMasterId ?? undefined);

  // V2.0 本轮结算卡片流（签到/结算/复核/购买/赠送/称号都在内）
  const settlements = getSettlementsSince(db, userId, turnStart);

  return {
  replyText,
  toolSummaries,
  stateChanged,
  settlementNotices,
  ceremony,
  settlements,
  reminderNotices,
  userMessageId,
  masterMessageId,
  };
}

/**
 * 回复后处理：清掉 LLM 残留的 AI 腔痕迹。
 *
 * 提示词层（buildVoiceLayer）是第一道防线，这里是第二道——
 * 模型偶尔仍会漏出破折号或 markdown，机械替换比重新生成便宜得多。
 * DESIGN-DECISION: 只做确定性替换，不做内容改写（改写需要额外 LLM 调用，
 * 且会破坏人设语气）。宁可语气略硬，也不引入新的不确定性。
 */
export function sanitizeReply(text: string): string {
  let out = text;

  // V1.7 完整性：会长的嘴不允许报奖励数值（骨架层铁律的代码兜底）。
  // 只清洗"数字 + 奖励单位"的组合，不碰普通数字（"50 个""三章"是正常叙事）。
  out = out.replace(/[+＋]?\s*\d+(?:\.\d+)?\s*(?:XP|xp|经验值?)/g, "……");
  out = out.replace(/[+＋]?\s*\d+\s*金币/g, "……");
  out = out.replace(/(?:体魄|心智|意志|财富|社交|创造)\s*[+＋]\s*\d+(?:\s*点)?/g, "……");
  out = out.replace(/\bLv\.?\s*\d+\b/g, "……");

  // 破折号 → 句号（断成两句，比顿号更自然）
  out = out.replace(/\s*——\s*/g, "。");
  out = out.replace(/\s*--\s*/g, "。");
  // 处理替换后可能出现的句末连标点
  out = out.replace(/。。+/g, "。").replace(/([。！？])\s*。+/g, "$1");

  // markdown 粗体 / 斜体
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  // 行首 markdown 标题
  out = out.replace(/^#{1,6}\s+/gm, "");

  // 行首列表符号 - / * （保留 "1." 这类朴素编号）
  out = out.replace(/^\s*[-*]\s+/gm, "");

  // 常见 emoji 装饰（会长不会用）
  out = out.replace(/[\u2705\u2728\u{1f389}\u{1f525}\u{1f4aa}\u{1f60a}]/gu, "");

  // 收尾清理多余空行
  out = out.replace(/\n{3,}/g, "\n\n").trim();

  return out;
}

// ============================================================================
// P0 聊天（酒馆）管线：与任务管线完全隔离
//
// 无工具、无结算/签到/成就/事件/复核等一切任务引擎副作用、不过 sanitizeReply
// （那套清洗是习惯场景的，会破坏 RP）。P11：只共享会长卡/记忆/冒险者卡，
// 亲密度与送礼完全是任务页的事，聊天不再推进亲密度、也不注入关系阶段。
// ============================================================================

export interface ChatConversationResult {
  replyText: string;
  userMessageId: string;
  masterMessageId: string;
}

/**
 * 聊天开场白（P1/P10）：进入某段会话且它还是空的时，把卡面 first_mes 作为
 * 第一条消息落库（幂等）。会话 id 由调用方保证（ensureActiveSession）。
 */
export function ensureChatGreeting(db: Db, userId: string, sessionId: string): void {
  const session = db
  .select()
  .from(chatSessions)
  .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
  .get();
  if (!session) return;

  const existing = db
  .select({ id: chatLog.id })
  .from(chatLog)
  .where(
  and(
  eq(chatLog.userId, userId),
  eq(chatLog.mode, "chat"),
  eq(chatLog.sessionId, sessionId),
  inArray(chatLog.role, ["user", "master"]),
  ),
  )
  .limit(1)
  .all();
  if (existing.length > 0) return;

  const master = db
  .select()
  .from(masters)
  .where(eq(masters.id, session.masterId))
  .get();
  if (!master) return;
  const card = parseCard(master.personaJson);
  insertChat(
    db,
    userId,
    "master",
    expandReplyMacros(deriveGreeting(card, master.name, 0), master.name),
    master.id,
    "chat",
    sessionId,
  );
}

/** 开场白候选 + 当前用的是第几条（聊天页「换一条」按钮用） */
export function chatGreetingOptions(
  db: Db,
  userId: string,
  sessionId: string,
): { greetings: string[]; currentIndex: number } {
  const session = db
  .select()
  .from(chatSessions)
  .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
  .get();
  if (!session) return { greetings: [], currentIndex: 0 };
  const master = db
  .select()
  .from(masters)
  .where(eq(masters.id, session.masterId))
  .get();
  if (!master) return { greetings: [], currentIndex: 0 };
  const greetings = allGreetings(parseCard(master.personaJson));
  return {
  greetings,
  currentIndex: greetingIndexOf(db, userId, sessionId, greetings, master.name),
  };
}

/**
 * 当前开场白在候选里的下标（找不到则 0）。
 *
 * 落库的开场白已过 expandReplyMacros（{{char}}/{{user}} 被替换、未知宏被清），
 * 所以要用同样的宏展开去比对卡面原文——直接 indexOf 原文会因宏差异恒返回 0，
 * 导致「换一条开场白」永远停在第 2 条（只在卡里含宏时爆发）。
 */
function greetingIndexOf(
  db: Db,
  userId: string,
  sessionId: string,
  greetings: string[],
  masterName: string,
): number {
  if (greetings.length === 0) return 0;
  const first = db
  .select({ content: chatLog.content })
  .from(chatLog)
  .where(
  and(
  eq(chatLog.userId, userId),
  eq(chatLog.mode, "chat"),
  eq(chatLog.sessionId, sessionId),
  eq(chatLog.role, "master"),
  ),
  )
  .orderBy(chatLog.createdAt)
  .limit(1)
  .get();
  if (!first) return 0;
  const idx = greetings.findIndex(
    (g) => expandReplyMacros(g, masterName) === first.content,
  );
  return idx >= 0 ? idx : 0;
}

/**
 * 换一条开场白（P9 swipe，P10 会话内）：删掉本会话的会长开场白，换成下一条。
 * 只在「用户还没开始说话」时可用。
 */
export function cycleChatGreeting(
  db: Db,
  userId: string,
  sessionId: string,
): { ok: boolean; reason?: string; greeting?: string; index?: number; total?: number } {
  const session = db
  .select()
  .from(chatSessions)
  .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
  .get();
  if (!session) return { ok: false, reason: "会话不存在" };
  const master = db
  .select()
  .from(masters)
  .where(eq(masters.id, session.masterId))
  .get();
  if (!master) return { ok: false, reason: "会长不存在" };

  if (sessionHasUserMessage(db, userId, sessionId)) {
  return { ok: false, reason: "这段对话已经开始了，开场白不能再换" };
  }

  const greetings = allGreetings(parseCard(master.personaJson));
  if (greetings.length <= 1) {
  return { ok: false, reason: "这位会长只有一条开场白" };
  }
  const nextIndex = (greetingIndexOf(db, userId, sessionId, greetings, master.name) + 1) % greetings.length;

  db.delete(chatLog)
  .where(
  and(
  eq(chatLog.userId, userId),
  eq(chatLog.mode, "chat"),
  eq(chatLog.sessionId, sessionId),
  eq(chatLog.role, "master"),
  ),
  )
  .run();
  const nextGreeting = expandReplyMacros(greetings[nextIndex], master.name);
  insertChat(db, userId, "master", nextGreeting, master.id, "chat", sessionId);

  return { ok: true, greeting: nextGreeting, index: nextIndex, total: greetings.length };
}

/**
 * 聊天模式单轮：会长卡系统提示词 + 最近 20 轮聊天历史 → LLM 纯文本回复。
 * 历史按 mode='chat' 且限定在当前会长任期内，任务管线的消息不会串进来。
 */
export async function runChatConversation(
  db: Db,
  userId: string,
  userMessage: string,
  sessionId: string,
  opts: ConversationOptions = {},
): Promise<ChatConversationResult> {
  const ctx = loadChatPromptContext(db, userId, sessionId);
  const history = loadHistory(db, userId, "chat", sessionId);

  // P2 世界书：按最近历史扫描激活；before/after 进系统提示词，at_depth 注入历史
  const sessionRow = db
  .select()
  .from(chatSessions)
  .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
  .get();
  const entries = listWorldBookEntries(db, userId, sessionRow?.masterId ?? null);
  const activation = activateWorldBook(entries, {
    messages: history.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  });

  const systemPrompt = buildChatPrompt({
    ...ctx,
    worldInfoBefore: activation.before,
    worldInfoAfter: activation.after,
    adultContent: getRpSettings(db).enabled,
  });

  const messages: ModelMessage[] = [...history];
  // at_depth：system 角色并入系统提示词（AI SDK 不允许 messages 里出现 system）；
  // user/assistant 角色插到倒数第 depth 条之前。仅本回合提示词，不落库。
  const depthSystemParts: string[] = [];
  const inserts: { index: number; role: "user" | "assistant"; content: string }[] = [];
  for (const d of activation.depth) {
    if (d.role === "system") {
      depthSystemParts.push(d.content);
    } else {
      inserts.push({
        index: Math.max(0, messages.length - d.depth),
        role: d.role,
        content: d.content,
      });
    }
  }
  inserts.sort((a, b) => a.index - b.index);
  let offset = 0;
  for (const ins of inserts) {
    messages.splice(ins.index + offset, 0, { role: ins.role, content: ins.content });
    offset++;
  }
  messages.push({ role: "user", content: userMessage });

  const fullSystemPrompt = depthSystemParts.length
    ? `${systemPrompt}\n\n${depthSystemParts.join("\n")}`
    : systemPrompt;

  // 先生成、后落库：失败/重发不会在库里留下重复的用户消息
  const model = opts.model ?? modelFromDb(db);
  let replyText = "";
  try {
  if (opts.onEvent) {
  // 流式：边生成边把增量文本推给前端
  const stream = streamText({
  model,
  system: fullSystemPrompt,
  messages,
  // 聊天模式要给足篇幅（R18 附加规则要求重要场景 2k~5k 字）：显式放开上限
  maxOutputTokens: 8000,
  abortSignal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
  });
  for await (const part of stream.stream) {
  if (part.type === "text-delta") {
  opts.onEvent({ type: "delta", text: part.text });
  } else if (part.type === "error") {
  throw part.error;
  }
  }
  replyText = await stream.text;
  } else {
  const result = await generateText({
  model,
  system: fullSystemPrompt,
  messages,
  maxOutputTokens: 8000,
  abortSignal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
  });
  replyText = result.text;
  }
  } catch (e) {
  // 超时走兜底文本；其余错误（含 Key 无效）抛给路由层
  if (!isTimeoutError(e)) throw e;
  }

  if (!replyText) {
  replyText = `（${ctx.masterName}顿了一下，没接上话。你再说一次？）`;
  }

  // 清掉模型照抄出来的卡宏（{{user}}/{{char}} 等）
  replyText = expandReplyMacros(replyText, ctx.masterName, ctx.userName);

  const userMessageId = insertChat(db, userId, "user", userMessage, undefined, "chat", sessionId);
  touchSession(db, userId, sessionId);

  // 刻意不做 sanitizeReply：RP 语境里清洗破折号/markdown 是破坏性的
  const masterMessageId = insertChat(
  db,
  userId,
  "master",
  replyText,
  sessionRow?.masterId ?? undefined,
  "chat",
  sessionId,
  );
  touchSession(db, userId, sessionId);

  // P12 每轮后台抽取长期记忆（不阻塞回复；无判定模型时跳过）。
  // 抽取结果写入当前（聊天）会长的记忆书，供以后的任务/聊天注入。
  const extractor =
    opts.memoryExtractor !== undefined ? opts.memoryExtractor : defaultMemoryExtractor(db);
  if (extractor && sessionRow?.masterId) {
    const masterId = sessionRow.masterId;
    void extractChatMemories(db, userId, masterId, sessionId, ctx.masterName, {
      extractor,
    }).catch((e) =>
      console.error("[memory-extract] 后台抽取失败：", e instanceof Error ? e.message : e),
    );
  }

  return { replyText, userMessageId, masterMessageId };
}

/**
 * P12 聊天记忆抽取：取最近若干条会话消息，交给抽取员产出候选记忆，
 * 查重后写入当前会长的记忆书，返回新增条数。纯编排，可单测。
 */
export async function extractChatMemories(
  db: Db,
  userId: string,
  masterId: string,
  sessionId: string,
  masterName: string,
  opts: { extractor: MemoryExtractor; limit?: number },
): Promise<number> {
  const limit = opts.limit ?? 12;
  const rows = db
    .select()
    .from(chatLog)
    .where(
      and(
        eq(chatLog.userId, userId),
        eq(chatLog.mode, "chat"),
        eq(chatLog.sessionId, sessionId),
        inArray(chatLog.role, ["user", "master"]),
      ),
    )
    .orderBy(desc(chatLog.createdAt))
    .limit(limit)
    .all()
    .reverse();
  if (rows.length === 0) return 0;
  const transcript = rows
    .map((r) => `${r.role === "user" ? "冒险者" : masterName}：${r.content}`)
    .join("\n");
  const items = await opts.extractor.extract({ masterName, transcript });
  if (items.length === 0) return 0;
  return saveExtractedMemories(db, userId, masterId, items, sessionId);
}
