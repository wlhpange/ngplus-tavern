import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import { character, quests, settlementLog, titles } from "./db/schema";
import { startOfMonth, startOfToday } from "./util/time";
import {
  levelFromXp,
  xpRequiredForNextLevel,
  xpToNextLevel,
  rankFromLevel,
} from "./engine/leveling";

export interface AttrSummary {
  xp: number;
  level: number;
  xpToNext: number;
}

export interface CharacterSummary {
  userId: string;
  totalXp: number;
  totalLevel: number;
  xpToNextLevel: number;
  nextLevelXpRequired: number;
  /** 冒险者评级（由总等级映射；XP 不减，天然只升不降） */
  rank: string;
  gold: number;
  attrs: Record<string, AttrSummary>;
  titles: string[];
}

const ATTR_COLUMNS = [
  ["vitality", "vitalityXp"],
  ["mind", "mindXp"],
  ["willpower", "willpowerXp"],
  ["wealth", "wealthXp"],
  ["social", "socialXp"],
  ["creativity", "creativityXp"],
] as const;

/** 角色面板聚合查询：等级/六维/金币/称号/评级（供工具、状态层、API 复用） */
export function getCharacterSummary(db: Db, userId: string): CharacterSummary {
  const row = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (!row) {
  throw new Error(`角色数据不存在：${userId}`);
  }

  const attrs: Record<string, AttrSummary> = {};
  for (const [key, col] of ATTR_COLUMNS) {
  const xp = row[col];
  attrs[key] = {
  xp,
  level: levelFromXp(xp),
  xpToNext: xpToNextLevel(xp),
  };
  }

  const totalLevel = levelFromXp(row.totalXp);
  const titleRows = db
  .select()
  .from(titles)
  .where(eq(titles.userId, userId))
  .orderBy(desc(titles.grantedAt))
  .all();

  return {
  userId,
  totalXp: row.totalXp,
  totalLevel,
  xpToNextLevel: xpToNextLevel(row.totalXp),
  nextLevelXpRequired: xpRequiredForNextLevel(totalLevel),
  rank: rankFromLevel(totalLevel),
  gold: row.gold,
  attrs,
  titles: titleRows.map((t) => t.titleKey),
  };
}

/**
 * 当日已入账 XP（软上限增量口径；）。
 * DESIGN-DECISION: 按当日所有 kind 的 xp_awarded 合计（含复核追加/购买不产 XP），
 * 结算工具与复核管线共用，保证两处口径永远一致。
 */
export function getTodaySettledXp(db: Db, userId: string): number {
  const row = db
  .select({ total: sql<number>`COALESCE(SUM(${settlementLog.xpAwarded}), 0)` })
  .from(settlementLog)
  .where(
  and(
  eq(settlementLog.userId, userId),
  gte(settlementLog.createdAt, startOfToday()),
  ),
  )
  .get();
  return row?.total ?? 0;
}

export interface SettlementRecord {
  id: string;
  kind: string;
  questTitle: string | null;
  completionRatio: number | null;
  confidence: number | null;
  xpAwarded: number;
  goldAwarded: number;
  /** 属性分流明细，如 {"vitality": 16, "willpower": 7} */
  attrSplit: Record<string, number>;
  /** V1.5 复核/购买明细（adjustments_json），无则 null */
  adjustments: Record<string, unknown> | null;
  createdAt: number;
}

export interface MonthSummary {
  xp: number;
  gold: number;
  count: number;
}

/** 本自然月汇总（面板月账单抬头用；口径与 settlement_log 一致） */
export function getMonthSummary(
  db: Db,
  userId: string,
  now: Date = new Date(),
): MonthSummary {
  const from = startOfMonth(now);
  const row = db
    .select({
      xp: sql<number>`COALESCE(SUM(${settlementLog.xpAwarded}), 0)`,
      gold: sql<number>`COALESCE(SUM(${settlementLog.goldAwarded}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(settlementLog)
    .where(
      and(eq(settlementLog.userId, userId), gte(settlementLog.createdAt, from)),
    )
    .get();
  return {
    xp: row?.xp ?? 0,
    gold: row?.gold ?? 0,
    count: row?.count ?? 0,
  };
}

/**
 * 结算历史（M3 对账视图）：全部来自 settlement_log，与面板数据同源。
 * 面板 XP/金币总额 = 历史结算的累计，可直接逐条对账。
 */
export function getRecentSettlements(
  db: Db,
  userId: string,
  limit = 20,
): SettlementRecord[] {
  return querySettlements(db, userId, [], limit);
}

/**
 * V2.0 对话时间线的结算卡片流：取 [from, to) 时间窗内的结算记录，
 * 按时间正序返回（与 chat_log 消息合并渲染）。
 */
export function getSettlementsInRange(
  db: Db,
  userId: string,
  from: number,
  to: number,
  limit = 100,
): SettlementRecord[] {
  return querySettlements(
    db,
    userId,
    [gte(settlementLog.createdAt, from), lt(settlementLog.createdAt, to)],
    limit,
  ).reverse();
}

/** V2.0 本轮结算（from 之后全部，用于 POST /api/chat 的即时卡片） */
export function getSettlementsSince(
  db: Db,
  userId: string,
  since: number,
  limit = 100,
): SettlementRecord[] {
  return querySettlements(
    db,
    userId,
    [gte(settlementLog.createdAt, since)],
    limit,
  ).reverse();
}

function querySettlements(
  db: Db,
  userId: string,
  extra: SQL[],
  limit: number,
): SettlementRecord[] {
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
  .where(and(eq(settlementLog.userId, userId), ...extra))
  .orderBy(desc(settlementLog.createdAt))
  .limit(limit)
  .all();
  return rows.map((r) => ({
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
  }));
}
