import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { chatSessions, chatLog } from "./db/schema";
import { deleteMemoriesForSessions } from "./memory";

/**
 * P10 聊天会话（酒馆式多会话）。
 *
 * 一家会长一张卡，但可以开多条互不干扰的对话；每段会话有自己的历史。
 * - 亲密度仍全局共享（两模式通用）。
 * - 换会长后旧会话仍归原会长（在该会长任内可见），不会串到新会长。
 * - scene 字段为后续立绘/背景预留。
 */

export interface ChatSession {
  id: string;
  masterId: string;
  title: string;
  scene: string | null;
  createdAt: number;
  updatedAt: number;
  /** 该会话的消息条数（列表展示用） */
  messageCount: number;
}

/** 某会长当前的会话列表（不含已归档），按最近更新倒序 */
export function listSessions(db: Db, userId: string, masterId: string): ChatSession[] {
  const rows = db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(chatSessions.masterId, masterId),
        isNull(chatSessions.archivedAt),
      ),
    )
    .all();
  return rows
    .map((s) => ({
      id: s.id,
      masterId: s.masterId,
      title: s.title,
      scene: s.scene,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: countMessages(db, userId, s.id),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function countMessages(db: Db, userId: string, sessionId: string): number {
  return db
    .select({ id: chatLog.id })
    .from(chatLog)
    .where(and(eq(chatLog.userId, userId), eq(chatLog.sessionId, sessionId)))
    .all().length;
}

export function getSession(db: Db, userId: string, sessionId: string): ChatSession | null {
  const s = db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .get();
  if (!s) return null;
  return {
    id: s.id,
    masterId: s.masterId,
    title: s.title,
    scene: s.scene,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: countMessages(db, userId, s.id),
  };
}

export function createSession(
  db: Db,
  userId: string,
  masterId: string,
  title = "新的对话",
): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(chatSessions)
    .values({ id, userId, masterId, title: title.trim() || "新的对话", scene: null, createdAt: now, updatedAt: now })
    .run();
  return id;
}

export function renameSession(db: Db, userId: string, sessionId: string, title: string): boolean {
  const res = db
    .update(chatSessions)
    .set({ title: title.trim().slice(0, 40) || "未命名对话", updatedAt: Date.now() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .run();
  return res.changes > 0;
}

/**
 * 设置 / 清除会话背景图。
 * scene 字段本就为「场景 / 立绘」预留，这里先存背景文件名（null = 无背景）。
 * 刻意不动 updatedAt：换背景不该把会话顶到列表最前。
 */
export function setSessionScene(
  db: Db,
  userId: string,
  sessionId: string,
  scene: string | null,
): boolean {
  const res = db
    .update(chatSessions)
    .set({ scene })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .run();
  return res.changes > 0;
}

/** 归档（软删除）会话，连带其消息与对话记忆（记忆随会话一起消失，不污染别处） */
export function deleteSession(db: Db, userId: string, sessionId: string): boolean {
  const s = db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .get();
  if (!s) return false;
  db.delete(chatLog)
    .where(and(eq(chatLog.userId, userId), eq(chatLog.sessionId, sessionId)))
    .run();
  db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
  deleteMemoriesForSessions(db, userId, [sessionId]);
  return true;
}

/** 某会长的全部会话 id（归档会长时连带清理用） */
export function listSessionIdsForMaster(
  db: Db,
  userId: string,
  masterId: string,
): string[] {
  return db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, userId), eq(chatSessions.masterId, masterId)))
    .all()
    .map((r) => r.id);
}

/**
 * 删除某会长的全部酒馆聊天记录：会话 + 消息 + 各对话的私有记忆。
 * 归档（删除）会长时调用——聊天记录必须随会长一起消失。返回删除的会话数。
 */
export function deleteSessionsForMaster(
  db: Db,
  userId: string,
  masterId: string,
): number {
  const ids = listSessionIdsForMaster(db, userId, masterId);
  if (ids.length === 0) return 0;
  db.delete(chatLog)
    .where(and(eq(chatLog.userId, userId), eq(chatLog.mode, "chat"), inArray(chatLog.sessionId, ids)))
    .run();
  db.delete(chatSessions)
    .where(and(eq(chatSessions.userId, userId), inArray(chatSessions.id, ids)))
    .run();
  deleteMemoriesForSessions(db, userId, ids);
  return ids.length;
}

export function touchSession(db: Db, userId: string, sessionId: string): void {
  db.update(chatSessions)
    .set({ updatedAt: Date.now() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .run();
}

/**
 * 取当前会长最近的会话；没有则新建一条。
 * 聊天页进入时调用：保证"总有一段可以说话"的会话。
 */
export function ensureActiveSession(db: Db, userId: string, masterId: string): string {
  const existing = db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(chatSessions.masterId, masterId),
        isNull(chatSessions.archivedAt),
      ),
    )
    .orderBy(desc(chatSessions.updatedAt))
    .get();
  if (existing) return existing.id;
  return createSession(db, userId, masterId);
}

/** 会话消息数 > 0 时是否已有用户发言（决定开场白能不能换） */
export function sessionHasUserMessage(db: Db, userId: string, sessionId: string): boolean {
  const row = db
    .select({ id: chatLog.id })
    .from(chatLog)
    .where(
      and(
        eq(chatLog.userId, userId),
        eq(chatLog.sessionId, sessionId),
        eq(chatLog.role, "user"),
      ),
    )
    .limit(1)
    .get();
  return Boolean(row);
}
