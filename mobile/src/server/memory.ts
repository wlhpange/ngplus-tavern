import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "./util/id";
import type { Db } from "./db";
import { memory } from "./db/schema";
import type { MemoryEntry } from "./llm/prompts";

/**
 * P12 记忆书：长期记忆的可编辑条目集合。
 *
 * 两种归属（scope）：
 * - 会长级「永久记忆」：session_id 为空。任务管线写入，一位会长自始至终只有一本。
 * - 酒馆「对话记忆」：session_id 指向某段 chat_sessions。每段对话各记一份，
 *   不同对话之间互不共享；聊天时还会带上该会长的永久记忆作为共同底子。
 *
 * 生成来源：任务管线的 add_memory 工具、聊天每轮结束后的后台抽取
 * （见 extractChatMemories / llm/reviewer）。
 */

export const MEMORY_CATEGORIES = [
  "profile",
  "preference",
  "event",
  "goal",
  "story",
  "relationship",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

/** 类别中文名（提示词层与设置页共用） */
export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  profile: "画像",
  preference: "偏好",
  event: "事件",
  goal: "目标",
  story: "剧情",
  relationship: "关系",
};

export interface MemoryRecord {
  id: string;
  masterId: string | null;
  sessionId: string | null;
  category: string;
  content: string;
  enabled: boolean;
  createdAt: number;
}

/** 每个类别注入提示词的条数上限（按时间取最近 N 条） */
export const MEMORY_PER_CATEGORY = 6;

function rowToRecord(r: typeof memory.$inferSelect): MemoryRecord {
  return {
    id: r.id,
    masterId: r.masterId ?? null,
    sessionId: r.sessionId ?? null,
    category: r.category,
    content: r.content,
    enabled: r.enabled !== 0,
    createdAt: r.createdAt,
  };
}

/**
 * 会长级永久记忆（session_id 为空）：任务管线用，也作为聊天时的共同底子。
 * masterId 为空时返回所有会长级条目（无会长时的兜底）。
 */
export function loadMemories(db: Db, userId: string, masterId?: string | null): MemoryEntry[] {
  return loadMemoriesForScope(db, userId, masterId, null);
}

/**
 * 按 scope 取用于注入提示词的记忆，按类别各取最近 N 条。
 * - sessionId 为空：只取会长级永久记忆（任务模式）。
 * - sessionId 非空：会长级永久记忆 + 该对话的私有记忆（聊天模式）。
 */
export function loadMemoriesForScope(
  db: Db,
  userId: string,
  masterId: string | null | undefined,
  sessionId: string | null | undefined,
): MemoryEntry[] {
  const rows = db
    .select()
    .from(memory)
    .where(and(eq(memory.userId, userId), eq(memory.enabled, 1)))
    .orderBy(desc(memory.createdAt))
    .all()
    .filter((r) => {
      const sid = r.sessionId ?? null;
      if (sessionId) {
        // 聊天：永久记忆（本会长）+ 本对话记忆
        return (sid === null && (!masterId || r.masterId === masterId)) || sid === sessionId;
      }
      // 任务 / 默认：只取会长级永久记忆
      return sid === null && (!masterId || r.masterId === masterId);
    });
  const perCategory = new Map<string, number>();
  const memories: MemoryEntry[] = [];
  for (const m of rows) {
    const n = perCategory.get(m.category) ?? 0;
    if (n < MEMORY_PER_CATEGORY) {
      memories.push({ category: m.category, content: m.content });
      perCategory.set(m.category, n + 1);
    }
  }
  return memories;
}

/**
 * 记忆书列表（设置页用）。
 * - 传 sessionId：该对话的私有条目；
 * - 只传 masterId：该会长的永久条目；
 * - 都不传：全部（含停用）。
 */
export function listMemories(
  db: Db,
  userId: string,
  masterId?: string | null,
  sessionId?: string | null,
): MemoryRecord[] {
  return db
    .select()
    .from(memory)
    .where(eq(memory.userId, userId))
    .orderBy(desc(memory.createdAt))
    .all()
    .filter((r) => {
      const sid = r.sessionId ?? null;
      if (sessionId) return sid === sessionId;
      if (masterId) return sid === null && r.masterId === masterId;
      return true;
    })
    .map(rowToRecord);
}

/** 归一化：去空白、去标点、转小写，用于查重 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？、,.!?；;：:"'“”‘’()（）]/g, "");
}

/** 是否与已有条目重复（归一化后完全相同即视为重复） */
function isDuplicate(content: string, existing: string[]): boolean {
  const n = normalize(content);
  if (!n) return true;
  return existing.some((e) => normalize(e) === n);
}

/**
 * 写入一条记忆（查重后落库）。返回 id；重复或非法返回 null。
 * sessionId 非空 = 写入该对话的私有记忆（查重只在该对话内）。
 */
export function addMemory(
  db: Db,
  userId: string,
  masterId: string | null,
  category: string,
  content: string,
  sessionId?: string | null,
): string | null {
  const text = content.trim().slice(0, 160);
  if (!text) return null;
  if (!isMemoryCategory(category)) return null;
  const sid = sessionId ?? null;
  // 只在同一 scope 内查重（对话记忆互不干扰，也不与永久记忆混查）
  const sameScope = listMemories(db, userId, sid ? null : masterId, sid).map((m) => m.content);
  if (isDuplicate(text, sameScope)) return null;
  const id = randomUUID();
  db.insert(memory)
    .values({
      id,
      userId,
      masterId: masterId ?? null,
      sessionId: sid,
      category,
      content: text,
      enabled: 1,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** 批量写入 AI 抽取的记忆，返回实际新增条数 */
export function saveExtractedMemories(
  db: Db,
  userId: string,
  masterId: string | null,
  items: { category: string; content: string }[],
  sessionId?: string | null,
): number {
  let added = 0;
  for (const it of items) {
    if (addMemory(db, userId, masterId, it.category, it.content, sessionId)) added++;
  }
  return added;
}

/** 修改某条记忆正文（设置页编辑） */
export function updateMemory(
  db: Db,
  userId: string,
  id: string,
  content: string,
): boolean {
  const text = content.trim().slice(0, 160);
  if (!text) return false;
  const res = db
    .update(memory)
    .set({ content: text })
    .where(and(eq(memory.id, id), eq(memory.userId, userId)))
    .run();
  return res.changes > 0;
}

/** 启用 / 停用某条记忆 */
export function setMemoryEnabled(
  db: Db,
  userId: string,
  id: string,
  enabled: boolean,
): boolean {
  const res = db
    .update(memory)
    .set({ enabled: enabled ? 1 : 0 })
    .where(and(eq(memory.id, id), eq(memory.userId, userId)))
    .run();
  return res.changes > 0;
}

/** 删除某条记忆 */
export function deleteMemory(db: Db, userId: string, id: string): boolean {
  const res = db
    .delete(memory)
    .where(and(eq(memory.id, id), eq(memory.userId, userId)))
    .run();
  return res.changes > 0;
}

/** 批量删除记忆（设置页多选）。返回实际删除条数 */
export function deleteMemories(db: Db, userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const res = db
    .delete(memory)
    .where(and(eq(memory.userId, userId), inArray(memory.id, ids)))
    .run();
  return res.changes;
}

/** 删除若干段酒馆对话的私有记忆（删会话 / 归档会长时连带清理） */
export function deleteMemoriesForSessions(
  db: Db,
  userId: string,
  sessionIds: string[],
): number {
  if (sessionIds.length === 0) return 0;
  const res = db
    .delete(memory)
    .where(and(eq(memory.userId, userId), inArray(memory.sessionId, sessionIds)))
    .run();
  return res.changes;
}
