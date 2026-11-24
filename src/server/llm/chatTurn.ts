import { and, desc, eq, inArray } from "drizzle-orm";
import { generateText, streamText, type ModelMessage } from "ai";
import type { Db } from "../db";
import { chatLog, chatSessions, masters } from "../db/schema";
import { allGreetings, deriveGreeting, parseCard } from "../cards";
import { modelFromDb } from "../modelConfig";
import { getRpSettings } from "../rp";
import { activateWorldBook, listWorldBookEntries } from "../worldbook";
import { saveExtractedMemories } from "../memory";
import { sessionHasUserMessage, touchSession } from "../chatSessions";
import { buildChatPrompt, expandReplyMacros } from "./prompts";
import {
  defaultMemoryExtractor,
  insertChat,
  loadChatPromptContext,
  loadHistory,
} from "./promptContext";
import {
  LLM_CALL_TIMEOUT_MS,
  isTimeoutError,
  type ConversationOptions,
} from "./turnShared";
import type { MemoryExtractor } from "./reviewer";

/**
 * P0 聊天（酒馆）管线：与任务管线完全隔离。
 *
 * 无工具、无结算/签到/成就/事件/复核等一切任务引擎副作用、不过 sanitizeReply
 * （那套清洗是习惯场景的，会破坏 RP）。P11：只共享会长卡/记忆/冒险者卡，
 * 亲密度与送礼完全是任务页的事，聊天不再推进亲密度、也不注入关系阶段。
 */

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
