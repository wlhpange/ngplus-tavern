import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { randomUUID } from "../util/id";
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
import { resolveLlmConfig } from "../modelConfig";
import { startOfToday } from "../util/time";
import { countActiveQuests } from "../cron/jobs";
import { config, type AttrKey } from "../engine/config";
import { checkinReward } from "../engine/checkin";
import { applyRankPromotion } from "../rankPromotion";
import { getSkillModifiers } from "../skills";
import { evaluateAchievements, type AchievementDef } from "../achievements";
import { getWeeklyBossState, maybeClaimWeeklyBoss } from "../weeklyBoss";
import { dailyEventNarrative, rollDailyEvent } from "../dailyEvent";
import { TOOL_DEFINITIONS, createToolContext, executeToolArgs, type ToolContext } from "./tools";
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
import {
  chatComplete,
  chatStream,
  type LlmConfig,
  type LlmMessage,
  type LlmTool,
} from "./client";

const HISTORY_LIMIT = 20;
const MAX_TOOL_ROUNDS = 5;

type ModelMessage = LlmMessage;

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /超时/.test(e.message));
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
  items?: { name: string; count: number }[];
}

export interface ConversationResult {
  replyText: string;
  toolSummaries: ToolSummary[];
  stateChanged: boolean;
  settlementNotices: string[];
  ceremony?: CeremonyEvent;
  settlements: SettlementRecord[];
  reminderNotices: string[];
  userMessageId: string;
  masterMessageId: string;
}

export type ConversationStreamEvent = { type: "delta"; text: string } | { type: "reset" };

export interface ConversationOptions {
  model?: LlmConfig;
  onEvent?: (e: ConversationStreamEvent) => void;
  toolContext?: ToolContext;
  dailyRand?: () => number;
  reviewer?: SettlementReviewer | null;
  memoryReviewer?: MemoryReviewer | null;
  memoryExtractor?: MemoryExtractor | null;
  signal?: AbortSignal;
}

function defaultReviewer(db: Db): SettlementReviewer | null {
  try {
    const cfg = resolveLlmConfig(db, "judge");
    if (!cfg.apiKey) return null;
    return createDeepSeekReviewer(cfg);
  } catch {
    return null;
  }
}

function defaultMemoryReviewer(db: Db): MemoryReviewer | null {
  try {
    const cfg = resolveLlmConfig(db, "judge");
    if (!cfg.apiKey) return null;
    return createMemoryReviewer(cfg);
  } catch {
    return null;
  }
}

function defaultMemoryExtractor(db: Db): MemoryExtractor | null {
  try {
    const cfg = resolveLlmConfig(db, "judge");
    if (!cfg.apiKey) return null;
    return createMemoryExtractor(cfg);
  } catch {
    return null;
  }
}

function recentContext(messages: ModelMessage[]): string {
  return messages
    .slice(-6)
    .map((m) => {
      const who = m.role === "user" ? "用户" : m.role === "assistant" ? "会长" : m.role;
      const text = typeof m.content === "string" ? m.content : "";
      return who + ": " + text.slice(0, 200);
    })
    .join("\n");
}

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

export function loadPromptContext(db: Db, userId: string) {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save?.activeMasterId) throw new Error("存档或会长缺失，请先完成初始化");
  const master = db.select().from(masters).where(eq(masters.id, save.activeMasterId)).get();
  if (!master) throw new Error(`会长不存在：${save.activeMasterId}`);
  const persona = parseCard(master.personaJson);

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
    if (q.type === "mainline") {
      const kids = db.select({ status: quests.status }).from(quests).where(eq(quests.parentQuestId, q.id)).all();
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
    intimacyStage: getAffinity(db, userId, master.id).stage,
    memories,
    activeQuests,
    character,
    todaySettlements,
    userPersona: buildUserPersonaLayer(userPersona),
    userName: userPersona.name,
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
    isOnboarding: save.onboardedAt == null,
  };
}

export function loadChatPromptContext(
  db: Db,
  userId: string,
  sessionId?: string | null,
): ChatPromptContext {
  const masterId = getChatMasterId(db, userId);
  if (!masterId) throw new Error("存档或会长缺失，请先完成初始化");
  const master = db.select().from(masters).where(eq(masters.id, masterId)).get();
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
  const conditions = [
    eq(chatLog.userId, userId),
    eq(chatLog.mode, mode),
    inArray(chatLog.role, ["user", "master"]),
  ];
  if (mode === "chat" && sessionId) conditions.push(eq(chatLog.sessionId, sessionId));
  if (mode === "quest" && masterId) conditions.push(eq(chatLog.masterId, masterId));
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

export function buildTools(): LlmTool[] {
  return TOOL_DEFINITIONS.map((d) => ({
    type: "function" as const,
    function: {
      name: d.function.name,
      description: d.function.description,
      parameters: d.function.parameters,
    },
  }));
}

function assistantWithCalls(text: string, calls: { id: string; name: string; arguments: string }[]): LlmMessage {
  if (calls.length === 0) return { role: "assistant", content: text };
  return {
    role: "assistant",
    content: text || null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    })),
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 任务管线单轮：五层提示词 + 最近 20 轮 + 用户新消息 → 模型 →
 * 工具循环（编排/留痕/复核由本项目掌控）→ 最终叙事。
 */
export async function runConversation(
  db: Db,
  userId: string,
  userMessage: string,
  opts: ConversationOptions = {},
): Promise<ConversationResult> {
  const turnStart = Date.now();
  const turnChatIds: string[] = [];
  const insertTurnChat = (role: "user" | "master" | "system", content: string, masterId?: string): string => {
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
  const stableSystemPrompt = buildSystemPrompt(promptCtx, { excludeState: true });
  const stateBlock = buildStateLayer(
    promptCtx.activeQuests,
    promptCtx.character,
    promptCtx.todaySettlements,
    promptCtx.weeklyBoss,
  );
  const turnNotes: string[] = [];
  const messages: ModelMessage[] = [];
  let messagesBuilt = false;
  let pendingRoundNotes: string[] | null = null;
  const addSystemNote = (text: string) => {
    if (!messagesBuilt) turnNotes.push(text);
    else if (pendingRoundNotes) pendingRoundNotes.push(text);
    else messages.push({ role: "system", content: text });
  };

  const userMessageId = insertTurnChat("user", userMessage, promptCtx.masterId);

  let model: LlmConfig;
  try {
    model = opts.model ?? resolveLlmConfig(db);
    if (!model.apiKey) throw new Error("会长还没拿到协会的印章（API Key）。去「设置 → 模型与渠道」填好 Key，回来就能说话了。");
  } catch (e) {
    rollbackTurn();
    throw e;
  }
  const toolCtx = opts.toolContext ?? createToolContext();
  const reviewer = opts.reviewer !== undefined ? opts.reviewer : defaultReviewer(db);
  const memoryReviewer = opts.memoryReviewer !== undefined ? opts.memoryReviewer : defaultMemoryReviewer(db);

  const toolSummaries: ToolSummary[] = [];
  const settlementNotices: string[] = [];
  const reminderNotices: string[] = [];
  let stateChanged = false;
  let ceremony: CeremonyEvent | undefined;
  const skillMods = getSkillModifiers(db, userId);

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

  const announceWeeklyBoss = () => {
    const claim = maybeClaimWeeklyBoss(db, userId);
    if (!claim) return;
    reminderNotices.push(`周常讨伐达成：「${claim.boss.name}」奖励已入袋`);
    insertTurnChat("system", `[周常] 达成「${claim.boss.name}」：${claim.boss.desc}`);
    addSystemNote(`【周常讨伐】本周悬赏「${claim.boss.name}」已经达成，奖励也入袋了。用一句你的话收个尾，别提具体数字。`);
  };
  announceWeeklyBoss();

  const dailyRoll = rollDailyEvent(db, userId, new Date(), opts.dailyRand);
  if (dailyRoll.event && dailyRoll.fresh) {
    const narrative = dailyEventNarrative(dailyRoll.event);
    reminderNotices.push(`今日事件 · ${narrative}`);
    insertTurnChat("system", `[每日事件] ${narrative}`);
    addSystemNote(`【每日事件】今天协会里发生了一件小事——${narrative}。开场自然地带一句，别提具体数值。`);
  }

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

      const reward = checkinReward(
        {
          primaryAttr: q.primaryAttr as AttrKey,
          primaryWeight: q.primaryWeight,
          secondaryAttr: (q.secondaryAttr ?? null) as AttrKey | null,
          secondaryWeight: q.secondaryWeight,
        },
        skillMods.checkinBonusRatio,
      );

      const charRow = db.select().from(character).where(eq(character.userId, userId)).get();
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

      db.update(character).set(updates as Partial<typeof character.$inferInsert>).where(eq(character.userId, userId)).run();
      db.update(quests).set({ streak: q.streak + 1, breakStreak: 0 }).where(eq(quests.id, q.id)).run();
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

  messages.push(
    ...questHistory,
    { role: "system", content: [stateBlock, ...turnNotes].filter(Boolean).join("\n\n") },
    { role: "user", content: userMessage },
  );
  messagesBuilt = true;

  let replyText = "";
  const tools = buildTools();
  let settledThisTurn = false;

  const callModel = async (): Promise<{
    text: string;
    toolCalls: { id: string; name: string; arguments: string }[];
    responseMessages: ModelMessage[];
  }> => {
    if (opts.onEvent) {
      let streamed = false;
      const r = await chatStream(model, {
        messages,
        tools,
        timeoutMs: 200_000,
        signal: opts.signal,
        onDelta: (text) => {
          streamed = true;
          opts.onEvent!({ type: "delta", text });
        },
      });
      if (r.toolCalls.length > 0 && streamed) opts.onEvent({ type: "reset" });
      return {
        text: r.text,
        toolCalls: r.toolCalls,
        responseMessages: [assistantWithCalls(r.text, r.toolCalls)],
      };
    }
    const r = await chatComplete(model, { messages, tools, timeoutMs: 200_000, signal: opts.signal });
    return {
      text: r.text,
      toolCalls: r.toolCalls,
      responseMessages: [assistantWithCalls(r.text, r.toolCalls)],
    };
  };

  const runRound = async (): Promise<{ text: string; hadToolCalls: boolean }> => {
    try {
      const { text, toolCalls, responseMessages } = await callModel();
      if (toolCalls.length === 0) return { text, hadToolCalls: false };

      messages.push(...responseMessages);
      pendingRoundNotes = [];

      const reviewTargets: ReviewTarget[] = [];
      for (const call of toolCalls) {
        const toolResult = executeToolArgs(db, userId, call.name, parseArgs(call.arguments), toolCtx);
        toolSummaries.push({ name: call.name, ok: toolResult.ok, summary: toolResult.summary });
        if (toolResult.stateChanged) stateChanged = true;
        if (call.name === "settle_completion" && toolResult.ok) {
          settlementNotices.push(toolResult.summary);
          settledThisTurn = true;
          const settleData = toolResult.data as {
            level_ups?: { scope: string; from: number; to: number }[];
            rank_up?: { from: string; to: string; gold: number; items?: { name: string; count: number }[] } | null;
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
          announceAchievements(evaluateAchievements(db, userId));
          announceWeeklyBoss();
        }
        if (toolResult.ok) {
          const data = toolResult.data as { settlement_id?: string; dispute_id?: string };
          if (call.name === "settle_completion" && data.settlement_id) {
            reviewTargets.push({ settlementId: data.settlement_id });
          }
          if (call.name === "file_dispute" && data.dispute_id && data.settlement_id) {
            reviewTargets.push({ settlementId: data.settlement_id, disputeId: data.dispute_id });
          }
        }
        if (call.name === "add_memory" && toolResult.ok && memoryReviewer) {
          const data = toolResult.data as { memory_id?: string; category?: string; content?: string };
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
        insertTurnChat("system", `[工具] ${call.name} → ${toolResult.ok ? "成功" : "失败"}：${toolResult.summary}`);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult.data ?? { ok: toolResult.ok, summary: toolResult.summary }),
        });
      }
      for (const note of pendingRoundNotes ?? []) messages.push({ role: "system", content: note });
      pendingRoundNotes = null;

      if (reviewer) {
        for (const target of reviewTargets) {
          const outcome = await runSettlementReview(db, userId, target.settlementId, {
            reviewer,
            disputeId: target.disputeId,
          });
          if (outcome.applied) stateChanged = true;
          if (outcome.notice) settlementNotices.push(outcome.notice);
          if (outcome.systemMessage) addSystemNote(outcome.systemMessage);
        }
      }
      return { text: "", hadToolCalls: true };
    } catch (e) {
      if (isTimeoutError(e)) return { text: "", hadToolCalls: false };
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

  const looksLikeReport = /交差|完成了|做完了|干完了|搞定了|汇报|超额|跑完|背完|读完|写完|录完|画完/.test(userMessage);
  const replyAsks = /[？?]/.test(replyText);
  if (replyText && !settledThisTurn && !replyAsks && looksLikeReport && countActiveQuests(db, userId) > 0) {
    const nudge =
      "【对账提醒】用户刚才的话像是一份战果汇报，但这一轮你没有调用 settle_completion。若确属汇报，立即调用工具补结算；若不是汇报或还缺细节，忽略本条，正常回话。";
    addSystemNote(nudge);
    const nudged = await runRound();
    if (nudged.hadToolCalls) {
      const final = await runRound();
      replyText = final.text || nudged.text;
      if (replyText) reminderNotices.push("有一笔战果刚才漏记了，已经补上。");
    } else if (nudged.text) {
      replyText = nudged.text;
      reminderNotices.push("有一笔战果似乎没记上？跟会长确认一下。");
    }
  }

  if (!replyText) replyText = "（会长提笔想了很久，又把纸揉掉了。请再说一次？）";
  replyText = sanitizeReply(replyText);
  replyText = expandReplyMacros(replyText, promptCtx.masterName, promptCtx.userName);

  const activeMaster = db.select().from(saves).where(eq(saves.userId, userId)).get();
  const masterMessageId = insertTurnChat("master", replyText, activeMaster?.activeMasterId ?? undefined);

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

export function sanitizeReply(text: string): string {
  let out = text;
  out = out.replace(/[+＋]?\s*\d+(?:\.\d+)?\s*(?:XP|xp|经验值?)/g, "……");
  out = out.replace(/[+＋]?\s*\d+\s*金币/g, "……");
  out = out.replace(/(?:体魄|心智|意志|财富|社交|创造)\s*[+＋]\s*\d+(?:\s*点)?/g, "……");
  out = out.replace(/\bLv\.?\s*\d+\b/g, "……");
  out = out.replace(/\s*——\s*/g, "。");
  out = out.replace(/\s*--\s*/g, "。");
  out = out.replace(/。。+/g, "。").replace(/([。！？])\s*。+/g, "$1");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^\s*[-*]\s+/gm, "");
  out = out.replace(/[\u2705\u2728\u{1f389}\u{1f525}\u{1f4aa}\u{1f60a}]/gu, "");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// ============================================================================
// 聊天（酒馆）管线：无工具、无任务引擎副作用、不做 sanitizeReply
// ============================================================================

export interface ChatConversationResult {
  replyText: string;
  userMessageId: string;
  masterMessageId: string;
}

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

  const master = db.select().from(masters).where(eq(masters.id, session.masterId)).get();
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
  const master = db.select().from(masters).where(eq(masters.id, session.masterId)).get();
  if (!master) return { greetings: [], currentIndex: 0 };
  const greetings = allGreetings(parseCard(master.personaJson));
  return { greetings, currentIndex: greetingIndexOf(db, userId, sessionId, greetings, master.name) };
}

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
  const idx = greetings.findIndex((g) => expandReplyMacros(g, masterName) === first.content);
  return idx >= 0 ? idx : 0;
}

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
  const master = db.select().from(masters).where(eq(masters.id, session.masterId)).get();
  if (!master) return { ok: false, reason: "会长不存在" };

  if (sessionHasUserMessage(db, userId, sessionId)) {
    return { ok: false, reason: "这段对话已经开始了，开场白不能再换" };
  }

  const greetings = allGreetings(parseCard(master.personaJson));
  if (greetings.length <= 1) return { ok: false, reason: "这位会长只有一条开场白" };
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

export async function runChatConversation(
  db: Db,
  userId: string,
  userMessage: string,
  sessionId: string,
  opts: ConversationOptions = {},
): Promise<ChatConversationResult> {
  const ctx = loadChatPromptContext(db, userId, sessionId);
  const history = loadHistory(db, userId, "chat", sessionId);

  const sessionRow = db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .get();
  const entries = listWorldBookEntries(db, userId, sessionRow?.masterId ?? null);
  const activation = activateWorldBook(entries, {
    messages: history.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    })),
  });

  const systemPrompt = buildChatPrompt({
    ...ctx,
    worldInfoBefore: activation.before,
    worldInfoAfter: activation.after,
    adultContent: getRpSettings(db).enabled,
  });

  const messages: ModelMessage[] = [...history];
  const depthSystemParts: string[] = [];
  const inserts: { index: number; role: "user" | "assistant"; content: string }[] = [];
  for (const d of activation.depth) {
    if (d.role === "system") depthSystemParts.push(d.content);
    else inserts.push({ index: Math.max(0, messages.length - d.depth), role: d.role, content: d.content });
  }
  inserts.sort((a, b) => a.index - b.index);
  let offset = 0;
  for (const ins of inserts) {
    messages.splice(ins.index + offset, 0, { role: ins.role, content: ins.content });
    offset++;
  }
  messages.push({ role: "user", content: userMessage });

  const fullSystemPrompt = depthSystemParts.length ? `${systemPrompt}\n\n${depthSystemParts.join("\n")}` : systemPrompt;
  const model = opts.model ?? resolveLlmConfig(db);
  if (!model.apiKey) throw new Error("会长还没拿到协会的印章（API Key）。去「设置 → 模型与渠道」填好 Key。");

  const withSystem: ModelMessage[] = [{ role: "system", content: fullSystemPrompt }, ...messages];
  let replyText = "";
  try {
    if (opts.onEvent) {
      const r = await chatStream(model, {
        messages: withSystem,
        maxTokens: 8000,
        timeoutMs: 200_000,
        signal: opts.signal,
        onDelta: (text) => opts.onEvent!({ type: "delta", text }),
      });
      replyText = r.text;
    } else {
      const r = await chatComplete(model, {
        messages: withSystem,
        maxTokens: 8000,
        timeoutMs: 200_000,
        signal: opts.signal,
      });
      replyText = r.text;
    }
  } catch (e) {
    if (!isTimeoutError(e)) throw e;
  }

  if (!replyText) replyText = `（${ctx.masterName}顿了一下，没接上话。你再说一次？）`;
  replyText = expandReplyMacros(replyText, ctx.masterName, ctx.userName);

  const userMessageId = insertChat(db, userId, "user", userMessage, undefined, "chat", sessionId);
  touchSession(db, userId, sessionId);
  const masterMessageId = insertChat(db, userId, "master", replyText, sessionRow?.masterId ?? undefined, "chat", sessionId);
  touchSession(db, userId, sessionId);

  const extractor = opts.memoryExtractor !== undefined ? opts.memoryExtractor : defaultMemoryExtractor(db);
  if (extractor && sessionRow?.masterId) {
    const masterId = sessionRow.masterId;
    void extractChatMemories(db, userId, masterId, sessionId, ctx.masterName, { extractor }).catch((e) =>
      console.error("[memory-extract] 后台抽取失败：", e instanceof Error ? e.message : e),
    );
  }

  return { replyText, userMessageId, masterMessageId };
}

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
  const transcript = rows.map((r) => `${r.role === "user" ? "冒险者" : masterName}：${r.content}`).join("\n");
  const items = await opts.extractor.extract({ masterName, transcript });
  if (items.length === 0) return 0;
  return saveExtractedMemories(db, userId, masterId, items, sessionId);
}
