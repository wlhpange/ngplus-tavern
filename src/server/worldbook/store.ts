import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { masterWorldBooks, worldBookEntries, worldBooks } from "../db/schema";
import {
  DEFAULT_DEPTH,
  type WorldBookEntry,
  type WorldBookPosition,
  type WorldBookRole,
} from "./core";

// ============================================================================
// 数据层：书册（world_books）+ 条目（world_book_entries）+ 多对多分配
// ============================================================================

export interface WorldBook {
  id: string;
  name: string;
  entryCount: number;
}

function rowToEntry(
  row: typeof worldBookEntries.$inferSelect,
  scope: 0 | 1,
): WorldBookEntry {
  const pos = row.position === "after" || row.position === "at_depth" ? row.position : "before";
  const role = row.role === "user" || row.role === "assistant" ? row.role : "system";
  return {
    id: row.id,
    scope,
    keys: safeArray(row.keys),
    secondaryKeys: safeArray(row.secondaryKeys),
    content: row.content,
    enabled: row.enabled !== 0,
    constant: row.constant !== 0,
    selective: row.selective !== 0,
    insertionOrder: row.insertionOrder,
    position: pos,
    depth: row.depth,
    role,
    priority: row.priority,
    caseSensitive: row.caseSensitive === 1,
    useRegex: row.useRegex !== 0,
    scanDepth: row.scanDepth,
    extensions: safeObject(row.extensions),
  };
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function safeObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- 书册 ----

/**
 * 迁移/兼容保留：把 P6 时期的"全局书"条目清掉（用户已决定不再要全局世界书）。
 * 幂等，可反复调用。
 */
export function purgeGlobalBooks(db: Db, userId: string): number {
  const globals = db
    .select()
    .from(worldBooks)
    .where(and(eq(worldBooks.userId, userId), eq(worldBooks.isGlobal, 1)))
    .all();
  for (const g of globals) {
    db.delete(worldBookEntries)
      .where(and(eq(worldBookEntries.userId, userId), eq(worldBookEntries.bookId, g.id)))
      .run();
    db.delete(worldBooks).where(eq(worldBooks.id, g.id)).run();
  }
  return globals.length;
}

export function listWorldBooks(db: Db, userId: string): WorldBook[] {
  const books = db
    .select()
    .from(worldBooks)
    .where(and(eq(worldBooks.userId, userId), eq(worldBooks.isGlobal, 0)))
    .all();
  return books
    .map((b) => ({
      id: b.id,
      name: b.name,
      entryCount: listBookEntries(db, userId, b.id).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createBook(db: Db, userId: string, name: string): string {
  const id = randomUUID();
  db.insert(worldBooks)
    .values({ id, userId, name: name.trim() || "未命名世界书", isGlobal: 0, createdAt: Date.now() })
    .run();
  return id;
}

export function renameBook(db: Db, userId: string, bookId: string, name: string): boolean {
  const res = db
    .update(worldBooks)
    .set({ name: name.trim() || "未命名世界书" })
    .where(and(eq(worldBooks.id, bookId), eq(worldBooks.userId, userId)))
    .run();
  return res.changes > 0;
}

/** 删除书册（连带条目与分配） */
export function deleteBook(db: Db, userId: string, bookId: string): boolean {
  const book = db
    .select()
    .from(worldBooks)
    .where(and(eq(worldBooks.id, bookId), eq(worldBooks.userId, userId)))
    .get();
  if (!book) return false;
  db.delete(worldBookEntries)
    .where(and(eq(worldBookEntries.userId, userId), eq(worldBookEntries.bookId, bookId)))
    .run();
  db.delete(masterWorldBooks)
    .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.bookId, bookId)))
    .run();
  db.delete(worldBooks).where(eq(worldBooks.id, bookId)).run();
  return true;
}

// ---- 分配（书册 ↔ 会长，多对多） ----

export function assignBook(db: Db, userId: string, masterId: string, bookId: string): void {
  const exists = db
    .select({ id: masterWorldBooks.id })
    .from(masterWorldBooks)
    .where(
      and(
        eq(masterWorldBooks.userId, userId),
        eq(masterWorldBooks.masterId, masterId),
        eq(masterWorldBooks.bookId, bookId),
      ),
    )
    .get();
  if (exists) return;
  db.insert(masterWorldBooks)
    .values({ id: randomUUID(), userId, masterId, bookId, createdAt: Date.now() })
    .run();
}

export function unassignBook(db: Db, userId: string, masterId: string, bookId: string): void {
  db.delete(masterWorldBooks)
    .where(
      and(
        eq(masterWorldBooks.userId, userId),
        eq(masterWorldBooks.masterId, masterId),
        eq(masterWorldBooks.bookId, bookId),
      ),
    )
    .run();
}

/** 某会长挂载的（非全局）书册 */
export function listBooksForMaster(db: Db, userId: string, masterId: string): WorldBook[] {
  const rows = db
    .select({ bookId: masterWorldBooks.bookId })
    .from(masterWorldBooks)
    .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.masterId, masterId)))
    .all();
  const ids = rows.map((r) => r.bookId);
  return listWorldBooks(db, userId).filter((b) => ids.includes(b.id));
}

/** 挂载了某书册的会长（多对多关系的反向查询；管理界面用） */
export function listMastersForBook(db: Db, userId: string, bookId: string): string[] {
  return db
    .select({ masterId: masterWorldBooks.masterId })
    .from(masterWorldBooks)
    .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.bookId, bookId)))
    .all()
    .map((r) => r.masterId);
}

// ---- 条目（按 book_id） ----

export function listBookEntries(db: Db, userId: string, bookId: string): WorldBookEntry[] {
  return db
    .select()
    .from(worldBookEntries)
    .where(and(eq(worldBookEntries.userId, userId), eq(worldBookEntries.bookId, bookId)))
    .all()
    .map((r) => rowToEntry(r, 0));
}

/**
 * 读取用于激活的条目：当前会长挂载的所有书册（一本可挂多个会长）。
 * 不再有"全局书"这一层——世界书只随角色卡/会长走。
 */
export function listWorldBookEntries(
  db: Db,
  userId: string,
  masterId: string | null,
): WorldBookEntry[] {
  if (!masterId) return [];
  const masterBookIds = db
    .select({ bookId: masterWorldBooks.bookId })
    .from(masterWorldBooks)
    .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.masterId, masterId)))
    .all()
    .map((r) => r.bookId);
  if (masterBookIds.length === 0) return [];

  return db
    .select()
    .from(worldBookEntries)
    .where(
      and(
        eq(worldBookEntries.userId, userId),
        inArray(worldBookEntries.bookId, masterBookIds),
      ),
    )
    .all()
    .map((r) => rowToEntry(r, 0));
}

export interface WorldBookInsert {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
  insertionOrder?: number;
  position?: WorldBookPosition;
  depth?: number;
  role?: WorldBookRole;
  priority?: number | null;
  caseSensitive?: boolean;
  useRegex?: boolean;
  scanDepth?: number | null;
  extensions?: Record<string, unknown>;
}

/** 批量落库到某本书（先清掉该书已有条目，导入幂等） */
export function replaceBookEntries(
  db: Db,
  userId: string,
  bookId: string,
  entries: WorldBookInsert[],
): number {
  db.delete(worldBookEntries)
    .where(and(eq(worldBookEntries.userId, userId), eq(worldBookEntries.bookId, bookId)))
    .run();
  appendBookEntries(db, userId, bookId, entries);
  return entries.length;
}

/** 追加落库（不删旧条目） */
export function appendBookEntries(
  db: Db,
  userId: string,
  bookId: string,
  entries: WorldBookInsert[],
): number {
  const now = Date.now();
  for (const e of entries) {
    db.insert(worldBookEntries)
      .values({ id: randomUUID(), userId, bookId, createdAt: now, ...toRowValues(e) })
      .run();
  }
  return entries.length;
}

/** WorldBookInsert → 表字段（不含 id/userId/bookId/createdAt） */
function toRowValues(e: WorldBookInsert) {
  return {
    keys: JSON.stringify(e.keys ?? []),
    secondaryKeys: JSON.stringify(e.secondaryKeys ?? []),
    content: e.content,
    enabled: e.enabled === false ? 0 : 1,
    constant: e.constant ? 1 : 0,
    selective: e.selective ? 1 : 0,
    insertionOrder: e.insertionOrder ?? 100,
    position: e.position ?? "before",
    depth: e.depth ?? DEFAULT_DEPTH,
    role: e.role ?? "system",
    priority: e.priority ?? null,
    caseSensitive: e.caseSensitive == null ? null : e.caseSensitive ? 1 : 0,
    useRegex: e.useRegex ? 1 : 0,
    scanDepth: e.scanDepth ?? null,
    extensions: JSON.stringify(e.extensions ?? {}),
  };
}

/** 新增或更新一条条目（id 命中的必须是本用户的条目） */
export function upsertBookEntry(
  db: Db,
  userId: string,
  bookId: string,
  input: WorldBookInsert & { id?: string },
): string {
  if (input.id) {
    const existing = db
      .select({ id: worldBookEntries.id })
      .from(worldBookEntries)
      .where(and(eq(worldBookEntries.id, input.id), eq(worldBookEntries.userId, userId)))
      .get();
    if (existing) {
      db.update(worldBookEntries)
        .set({ bookId, ...toRowValues(input) })
        .where(eq(worldBookEntries.id, input.id))
        .run();
      return input.id;
    }
  }
  const id = randomUUID();
  db.insert(worldBookEntries)
    .values({ id, userId, bookId, createdAt: Date.now(), ...toRowValues(input) })
    .run();
  return id;
}

/** 删除一条条目（按用户隔离） */
export function deleteBookEntry(db: Db, userId: string, id: string): boolean {
  const res = db
    .delete(worldBookEntries)
    .where(and(eq(worldBookEntries.id, id), eq(worldBookEntries.userId, userId)))
    .run();
  return res.changes > 0;
}

/**
 * 把会长卡内嵌的 character_book 落成一本命名书册并分配给该会长。
 * 导入卡片时使用；返回书册 id 与条目数。
 */
export function replaceMasterBookFromCharacterBook(
  db: Db,
  userId: string,
  masterId: string,
  masterName: string,
  characterBook: unknown,
): { bookId: string; entries: number } {
  const inserts = convertCharacterBook(characterBook);
  const bookId = createBook(db, userId, `${masterName}的世界书`);
  replaceBookEntries(db, userId, bookId, inserts);
  assignBook(db, userId, masterId, bookId);
  return { bookId, entries: inserts.length };
}

/** 归档会长：拆掉分配 + 删掉只属于它、且没别的会长在用的命名书册（全局书不动） */
export function removeMasterBooks(
  db: Db,
  userId: string,
  masterId: string,
): void {
  const bookIds = db
    .select({ bookId: masterWorldBooks.bookId })
    .from(masterWorldBooks)
    .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.masterId, masterId)))
    .all()
    .map((r) => r.bookId);
  for (const bookId of bookIds) {
    unassignBook(db, userId, masterId, bookId);
    const others = db
      .select({ id: masterWorldBooks.id })
      .from(masterWorldBooks)
      .where(and(eq(masterWorldBooks.userId, userId), eq(masterWorldBooks.bookId, bookId)))
      .all();
    const book = db.select().from(worldBooks).where(eq(worldBooks.id, bookId)).get();
    if (others.length === 0 && book?.isGlobal !== 1) {
      deleteBook(db, userId, bookId);
    }
  }
}

// ============================================================================
// Character Card V2/V3 character_book → 本项目条目
// ============================================================================

interface CcCharacterBookEntry {
  keys?: unknown;
  secondary_keys?: unknown;
  content?: unknown;
  enabled?: unknown;
  constant?: unknown;
  selective?: unknown;
  insertion_order?: unknown;
  position?: unknown;
  priority?: unknown;
  extensions?: Record<string, unknown>;
}
interface CcCharacterBook {
  entries?: CcCharacterBookEntry[];
  extensions?: Record<string, unknown>;
}

/** 把独立世界书 JSON（lorebook_v3 / {entries} / 裸数组）解析成条目 */
export function parseLorebook(raw: unknown): WorldBookInsert[] {
  if (Array.isArray(raw)) return convertCharacterBook({ entries: raw });
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const book = o.spec === "lorebook_v3" && o.data ? o.data : o;
    return convertCharacterBook(book);
  }
  return [];
}

/**
 * 把卡片内嵌的 character_book 转成本项目条目。
 * 规范里 V2 只能表达少数字段，酒馆等编辑器把进阶信息放在 entry.extensions，
 * 这里按 convertCharacterBook 的惯例读取，未支持的字段原样保留。
 */
export function convertCharacterBook(characterBook: unknown): WorldBookInsert[] {
  const book = characterBook as CcCharacterBook | null | undefined;
  const rawEntries = Array.isArray(book?.entries) ? book.entries : [];
  const asStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return rawEntries.map((e, index) => {
    const ext = (e.extensions ?? {}) as Record<string, unknown>;
    const posRaw = (ext.position ?? e.position) as unknown;
    let position: WorldBookPosition = "before";
    if (posRaw === "after" || posRaw === "after_char" || posRaw === 1 || posRaw === "1") {
      position = "after";
    } else if (posRaw === "at_depth" || posRaw === "atDepth" || posRaw === 4 || posRaw === "4") {
      position = "at_depth";
    }
    const depthNum = Number(ext.depth);
    const roleRaw = ext.role;
    const role: WorldBookRole =
      roleRaw === "user" || roleRaw === 1
        ? "user"
        : roleRaw === "assistant" || roleRaw === 2
          ? "assistant"
          : "system";
    const insertionOrder = Number(e.insertion_order);
    return {
      keys: asStrArray(e.keys),
      secondaryKeys: asStrArray(e.secondary_keys),
      content: typeof e.content === "string" ? e.content : "",
      enabled: e.enabled !== false,
      constant: e.constant === true,
      selective: e.selective === true,
      insertionOrder: Number.isFinite(insertionOrder) ? insertionOrder : index,
      position,
      depth: Number.isFinite(depthNum) ? depthNum : DEFAULT_DEPTH,
      role,
      priority: typeof e.priority === "number" ? e.priority : null,
      caseSensitive: typeof ext.case_sensitive === "boolean" ? ext.case_sensitive : undefined,
      useRegex: ext.use_regex === true,
      scanDepth: typeof ext.scan_depth === "number" ? ext.scan_depth : null,
      extensions: { ...ext, cc_index: index },
    };
  });
}
