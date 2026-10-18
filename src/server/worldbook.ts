import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { worldBookEntries, worldBooks, masterWorldBooks } from "./db/schema";

/**
 * P2 世界书（Lorebook）引擎 —— B 标准档。
 *
 * 对齐 Character Card V2/V3 的 Lorebook 子集，并实现酒馆的关键行为：
 * 常驻(constant) / 关键词 / selective+secondary_keys / scan_depth /
 * insertion_order / 位置(before·after·at_depth) / token 预算 / 概率 /
 * 递归扫描 / 装饰器（@@depth @@position @@role @@scan_depth @@activate 等）。
 * sticky/cooldown/delay/分组/outlet 等未执行的字段原样保留在 extensions。
 */

export type WorldBookPosition = "before" | "after" | "at_depth";
export type WorldBookRole = "system" | "user" | "assistant";

export interface WorldBookEntry {
  id: string;
  /** 0 = 角色书（优先），1 = 全局书 */
  scope: 0 | 1;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  insertionOrder: number;
  position: WorldBookPosition;
  depth: number;
  role: WorldBookRole;
  priority: number | null;
  caseSensitive: boolean;
  useRegex: boolean;
  scanDepth: number | null;
  extensions: Record<string, unknown>;
}

export const DEFAULT_SCAN_DEPTH = 2;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_BUDGET_TOKENS = 1500;
export const MAX_RECURSION_STEPS = 3;

/** 粗略 token 估算（中英混排）：仅用于预算截断，单调即可 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

const KNOWN_DECORATORS = new Set([
  "depth",
  "position",
  "role",
  "scan_depth",
  "activate",
  "dont_activate",
  "additional_keys",
  "exclude_keys",
]);

/**
 * 解析条目正文顶部的装饰器（@@name value；@@@ 为 fallback）。
 * 已知装饰器优先；未知装饰器看下一条 @@@ fallback。返回正文（已剥离装饰器）。
 */
export function parseDecorators(raw: string): {
  decorators: Record<string, string>;
  content: string;
} {
  const decorators: Record<string, string> = {};
  if (!raw.startsWith("@@")) return { decorators, content: raw };

  const lines = raw.split("\n");
  let i = 0;
  let accepted = true;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("@@")) break;
    const isFallback = line.startsWith("@@@");
    const body = isFallback ? line.slice(1) : line;
    const rest = body.slice(2);
    const name = rest.split(/\s/, 1)[0] ?? "";
    const value = rest.slice(name.length).trim();
    if (isFallback) {
      if (!accepted && name) {
        decorators[name] = value;
        accepted = true;
      }
    } else if (KNOWN_DECORATORS.has(name)) {
      decorators[name] = value;
      accepted = true;
    } else {
      accepted = false;
    }
  }
  return { decorators, content: lines.slice(i).join("\n") };
}

interface MatchOpts {
  caseSensitive?: boolean;
  useRegex?: boolean;
}

/** 关键词匹配（支持正则与大小写） */
export function matchKeys(haystack: string, keys: string[], opts: MatchOpts = {}): boolean {
  if (keys.length === 0) return false;
  const hay = opts.caseSensitive ? haystack : haystack.toLowerCase();
  return keys.some((raw) => {
    const k = raw?.trim();
    if (!k) return false;
    if (opts.useRegex) {
      try {
        return new RegExp(k, opts.caseSensitive ? "" : "i").test(haystack);
      } catch {
        return false;
      }
    }
    const needle = opts.caseSensitive ? k : k.toLowerCase();
    return hay.includes(needle);
  });
}

/** 取最近 depth 条消息拼成扫描缓冲 */
function buildHaystack(messages: { role: string; content: string }[], depth: number): string {
  const n = Math.max(0, depth);
  const recent = n === 0 ? [] : messages.slice(Math.max(0, messages.length - n));
  return recent.map((m) => m.content).join("\n");
}

export interface ActivateOptions {
  /** 最近消息（时间正序，最后一条最新） */
  messages: { role: string; content: string }[];
  budgetTokens?: number;
  /** 递归扫描开关（默认开，B 标准档） */
  recursive?: boolean;
}

export interface ActivatedWorldBook {
  before: string;
  after: string;
  depth: { depth: number; role: WorldBookRole; content: string }[];
  /** 本回合激活的条目 id（调试/测试/事件用） */
  activated: string[];
}

/**
 * 激活世界书：扫描 → 命中 → 预算截断 → 递归 → 按位置组装。
 * 纯函数（不碰 DB），可单测。
 */
export function activateWorldBook(
  entries: WorldBookEntry[],
  opts: ActivateOptions,
): ActivatedWorldBook {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const recursive = opts.recursive ?? true;

  // 角色书优先（scope 0），其次按 insertion_order 升序（低者先入提示词）
  const sorted = [...entries].sort(
    (a, b) => a.scope - b.scope || a.insertionOrder - b.insertionOrder || a.id.localeCompare(b.id),
  );

  const activated = new Map<string, WorldBookEntry>();
  const effectiveContent = new Map<string, string>();
  const effectiveDecorators = new Map<string, Record<string, string>>();
  let tokens = 0;
  let recurse = "";
  let steps = 0;
  let progressed = true;

  while (progressed && steps <= MAX_RECURSION_STEPS) {
    progressed = false;
    for (const entry of sorted) {
      if (activated.has(entry.id) || !entry.enabled) continue;

      const { decorators, content } = parseDecorators(entry.content);
      const scanDepth = decorators.scan_depth
        ? Number(decorators.scan_depth)
        : entry.scanDepth ?? DEFAULT_SCAN_DEPTH;
      const haystack = buildHaystack(opts.messages, scanDepth) + recurse;

      if (!entryMatches(entry, haystack, decorators)) continue;

      const cost = estimateTokens(content);
      const ignoreBudget = entry.extensions.ignore_budget === true;
      if (!ignoreBudget && tokens + cost > budget) continue; // 预算溢出：跳过（低优先级/低序先被丢）

      activated.set(entry.id, entry);
      effectiveContent.set(entry.id, content);
      effectiveDecorators.set(entry.id, decorators);
      tokens += cost;
      progressed = true;
      const preventRecursion = entry.extensions.prevent_recursion === true;
      if (!preventRecursion) recurse += "\n" + content;
    }
    steps++;
    if (!recursive) break;
  }

  // 组装：按 scope + insertion_order（低者在前）
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  const depthGroups = new Map<string, { depth: number; role: WorldBookRole; parts: string[] }>();

  for (const entry of sorted) {
    if (!activated.has(entry.id)) continue;
    const content = effectiveContent.get(entry.id) ?? entry.content;
    if (!content.trim()) continue;
    const decorators = effectiveDecorators.get(entry.id) ?? {};
    const position = (decorators.position as WorldBookPosition) ?? entry.position;
    const depth = decorators.depth ? Number(decorators.depth) : entry.depth;
    const role = (decorators.role as WorldBookRole) ?? entry.role;

    if (position === "after") {
      afterParts.push(content);
    } else if (position === "at_depth") {
      const key = `${depth}::${role}`;
      const g = depthGroups.get(key) ?? { depth, role, parts: [] };
      g.parts.push(content);
      depthGroups.set(key, g);
    } else {
      beforeParts.push(content);
    }
  }

  return {
    before: beforeParts.join("\n"),
    after: afterParts.join("\n"),
    depth: [...depthGroups.values()].map((g) => ({
      depth: g.depth,
      role: g.role,
      content: g.parts.join("\n"),
    })),
    activated: [...activated.keys()],
  };
}

/** 激活结果拼成一段注入文本（任务模式用；聊天模式按位置分别处理） */
export function activatedWorldBookText(a: ActivatedWorldBook): string {
  return [a.before, a.after, ...a.depth.map((d) => d.content)]
    .filter((s) => s.trim().length > 0)
    .join("\n");
}

/** 单条命中判定（含装饰器强制开关与 selective/secondary/additional/exclude） */
function entryMatches(
  entry: WorldBookEntry,
  haystack: string,
  decorators: Record<string, string>,
): boolean {
  if (decorators.activate !== undefined) return true;
  if (decorators.dont_activate !== undefined) return false;
  if (entry.constant) return true;

  const cs = entry.caseSensitive;
  const rx = entry.useRegex;
  const primary = matchKeys(haystack, entry.keys, { caseSensitive: cs, useRegex: rx });
  if (!primary) return false;

  if (entry.selective && entry.secondaryKeys.length > 0) {
    if (!matchKeys(haystack, entry.secondaryKeys, { caseSensitive: cs, useRegex: rx })) {
      return false;
    }
  }
  // 装饰器附加/排除关键词
  if (decorators.additional_keys) {
    const keys = decorators.additional_keys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length && !matchKeys(haystack, keys, { caseSensitive: cs, useRegex: rx })) {
      return false;
    }
  }
  if (decorators.exclude_keys) {
    const keys = decorators.exclude_keys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length && matchKeys(haystack, keys, { caseSensitive: cs, useRegex: false })) {
      return false;
    }
  }
  return true;
}

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
