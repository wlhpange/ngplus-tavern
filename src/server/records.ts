import { and, desc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import type { Db } from "./db";
import { chatLog, masters, quests, settlementLog } from "./db/schema";
import type { SettlementRecord } from "./character";

/**
 * 聊天记录（归档）与对话窗口的统一查询层。
 *
 * 产品规则（2026-09-27 定案）：
 * - 对话主页面只显示最近 3 个自然日（今天/昨天/前天）；
 * - 更早的内容进 /records 归档页，按月/日分组、可搜索、可筛选、分页加载。
 *
 * 本模块是纯 DB 函数层（可单测）：路由只做参数解析与组装。
 */

export type RecordItem =
  | {
      type: "message";
      id: string;
      role: "user" | "master";
      content: string;
      sender: string;
      createdAt: number;
    }
  | { type: "settlement"; settlement: SettlementRecord };

export type RecordKind = "all" | "chat" | "settlement";

/** 对话主界面的时间窗起点：今天 0 点往前推 2 天（= 含今天共 3 个自然日） */
export function chatWindowStart(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 2);
  return d.getTime();
}

/** 窗口之前是否还有内容（对话页据此显示「更早的对话在聊天记录 →」入口） */
export function hasRecordsBefore(
  db: Db,
  userId: string,
  before: number,
  mode: ChatMode = "quest",
  sessionId?: string | null,
  masterId?: string | null,
): boolean {
  const msg = db
    .select({ id: chatLog.id })
    .from(chatLog)
    .where(
      and(
        eq(chatLog.userId, userId),
        eq(chatLog.mode, mode),
        inArray(chatLog.role, ["user", "master"]),
        ...(sessionId ? [eq(chatLog.sessionId, sessionId)] : []),
        ...(mode === "quest" && masterId ? [eq(chatLog.masterId, masterId)] : []),
        lt(chatLog.createdAt, before),
      ),
    )
    .limit(1)
    .all();
  if (msg.length > 0) return true;
  // 结算卡片只属于任务管线，聊天模式没有
  if (mode === "chat") return false;
  const st = db
    .select({ id: settlementLog.id })
    .from(settlementLog)
    .where(
      and(
        eq(settlementLog.userId, userId),
        lt(settlementLog.createdAt, before),
        ...(masterId ? [settlementBelongsToMaster(masterId)] : []),
      ),
    )
    .limit(1)
    .all();
  return st.length > 0;
}

/** 对话模式：quest=任务管线，chat=聊天（酒馆）管线 */
export type ChatMode = "quest" | "chat";

/**
 * 结算卡片「归属当时在任的会长」的判定（P11）：用 master_history 任期匹配
 * 结算发生时刻。无需给 settlement_log 加列——任期表覆盖建库以来的所有时间点。
 */
function settlementBelongsToMaster(masterId: string) {
  return sql`EXISTS (
    SELECT 1 FROM master_history mh
    JOIN saves s ON s.id = mh.save_id
    WHERE s.user_id = ${settlementLog.userId}
      AND mh.started_at <= ${settlementLog.createdAt}
      AND (mh.ended_at IS NULL OR ${settlementLog.createdAt} < mh.ended_at)
      AND mh.master_id = ${masterId}
  )`;
}

export interface RecordsQuery {
  /** 游标：只取 createdAt < before 的内容（归档翻页用） */
  before?: number | null;
  /** 只取 createdAt >= since 的内容（对话三天窗口用） */
  since?: number | null;
  limit?: number;
  /** 关键词：消息查正文，结算查委托名与判定理由 */
  q?: string;
  kind?: RecordKind;
  /** 结算流细分：只取这些 kind（面板月账单筛选用） */
  settlementKinds?: string[];
  /** P0 对话模式：默认 quest；chat 时只取聊天流、不并入结算卡片 */
  mode?: ChatMode;
  /** P10 聊天会话：指定后只取该会话的消息（聊天模式用） */
  sessionId?: string | null;
  /** 任务模式：只取该会长主线的消息（结算仍为全局账本，不按会长过滤） */
  masterId?: string | null;
}

export interface RecordsResult {
  /** 倒序（最新在前）——归档页逐页向下翻；对话页自行反转 */
  items: RecordItem[];
  hasMore: boolean;
  nextBefore: number | null;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

export function queryRecords(
  db: Db,
  userId: string,
  opts: RecordsQuery = {},
): RecordsResult {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );
  const kind = opts.kind ?? "all";
  const mode: ChatMode = opts.mode ?? "quest";
  const q = opts.q?.trim() ?? "";
  const before = opts.before != null && opts.before > 0 ? opts.before : null;
  const since = opts.since != null && opts.since > 0 ? opts.since : null;

  const items: RecordItem[] = [];

  // 消息流
  if (kind !== "settlement") {
    const conditions = [
      eq(chatLog.userId, userId),
      eq(chatLog.mode, mode),
      inArray(chatLog.role, ["user", "master"]),
      // P10：指定会话时只取该会话的消息
      ...(opts.sessionId ? [eq(chatLog.sessionId, opts.sessionId)] : []),
      // 任务模式：只取当前会长的消息（结算分支不受影响，仍是全局账本）
      ...(mode === "quest" && opts.masterId ? [eq(chatLog.masterId, opts.masterId)] : []),
      ...(before != null ? [lt(chatLog.createdAt, before)] : []),
      ...(since != null ? [gte(chatLog.createdAt, since)] : []),
      ...(q ? [like(chatLog.content, `%${q}%`)] : []),
    ];
    const rows = db
      .select()
      .from(chatLog)
      .where(and(...conditions))
      .orderBy(desc(chatLog.createdAt))
      .limit(limit + 1)
      .all();
    const nameMap = masterNameMap(db);
    for (const r of rows) {
      items.push({
        type: "message",
        id: r.id,
        role: r.role === "user" ? "user" : "master",
        content: r.content,
        sender: r.role === "master" ? nameMap.get(r.masterId ?? "") ?? "会长" : "你",
        createdAt: r.createdAt,
      });
    }
  }

  // 结算流（仅任务管线；聊天模式没有结算卡片）
  if (kind !== "chat" && mode === "quest") {
    const conditions = [
      eq(settlementLog.userId, userId),
      ...(before != null ? [lt(settlementLog.createdAt, before)] : []),
      ...(since != null ? [gte(settlementLog.createdAt, since)] : []),
      // P11：任务流按「结算当时在任的会长」过滤；归档页不传 masterId → 全局
      ...(mode === "quest" && opts.masterId
        ? [settlementBelongsToMaster(opts.masterId)]
        : []),
      ...(opts.settlementKinds?.length
        ? [inArray(settlementLog.kind, opts.settlementKinds)]
        : []),
      ...(q
        ? [
            or(
              like(quests.title, `%${q}%`),
              like(settlementLog.llmReasoning, `%${q}%`),
            )!,
          ]
        : []),
    ];
    const rows = db
      .select({
        id: settlementLog.id,
        kind: settlementLog.kind,
        questTitle: quests.title,
        completionRatio: settlementLog.completionRatio,
        confidence: settlementLog.confidence,
        xpAwarded: settlementLog.xpAwarded,
        goldAwarded: settlementLog.goldAwarded,
        attrSplitJson: settlementLog.attrSplitJson,
        adjustmentsJson: settlementLog.adjustmentsJson,
        createdAt: settlementLog.createdAt,
      })
      .from(settlementLog)
      .leftJoin(quests, eq(settlementLog.questId, quests.id))
      .where(and(...conditions))
      .orderBy(desc(settlementLog.createdAt))
      .limit(limit + 1)
      .all();
    for (const r of rows) {
      items.push({
        type: "settlement",
        settlement: {
          id: r.id,
          kind: r.kind,
          questTitle: r.questTitle,
          completionRatio: r.completionRatio,
          confidence: r.confidence,
          xpAwarded: r.xpAwarded,
          goldAwarded: r.goldAwarded,
          attrSplit: JSON.parse(r.attrSplitJson) as Record<string, number>,
          adjustments: r.adjustmentsJson
            ? (JSON.parse(r.adjustmentsJson) as Record<string, unknown>)
            : null,
          createdAt: r.createdAt,
        },
      });
    }
  }

  // 合并：倒序（同刻按 用户发言 → 结算 → 会长回复 的相对先后反转）
  const rank = (it: RecordItem): number =>
    it.type === "settlement" ? 1 : it.role === "user" ? 0 : 2;
  const itemTime = (it: RecordItem): number =>
    it.type === "settlement" ? it.settlement.createdAt : it.createdAt;
  items.sort((a, b) => itemTime(a) - itemTime(b) || rank(a) - rank(b));
  items.reverse();

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextBefore = page.length > 0 ? itemTime(page[page.length - 1]) : null;

  return { items: page, hasMore, nextBefore };
}

/** master_id → 名字（含已卸任会长） */
function masterNameMap(db: Db): Map<string, string> {
  const rows = db.select({ id: masters.id, name: masters.name }).from(masters).all();
  return new Map(rows.map((m) => [m.id, m.name]));
}
