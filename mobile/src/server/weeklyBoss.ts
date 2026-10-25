import { and, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "./util/id";
import type { Db } from "./db";
import { character, items, memory, quests, settlementLog } from "./db/schema";
import { config } from "./engine/config";
import { startOfWeek, weekKey } from "./util/time";
import { shopCatalog } from "./shop";

/**
 * 周常 Boss（V3）：每周刷新一个累计型挑战，达标后掉落稀有道具。
 * - 本周是哪只：由周标识（周一的日期）稳定哈希到 economy_config.weekly_boss.pool
 * - 进度：从 settlement_log / quests 实时推导，不新增计数表
 * - 领奖：写入 settlement_log（kind="weekly_boss"）+ 金币 + 道具 + 记忆；每周幂等
 */

export interface WeeklyBossDef {
  key: string;
  name: string;
  desc: string;
  metric: "quests" | "xp" | "checkins";
  target: number;
  reward: { gold: number; item: string; item_count: number };
}

export function weeklyBossPool(): WeeklyBossDef[] {
  return (config.weekly_boss as { pool: WeeklyBossDef[] }).pool;
}

/** 稳定哈希（同周内所有请求得到同一只 Boss；跨周轮换） */
export function pickWeeklyBoss(now: Date = new Date()): WeeklyBossDef {
  const pool = weeklyBossPool();
  const key = weekKey(now);
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return pool[hash % pool.length];
}

export interface WeeklyBossState {
  week: string;
  boss: WeeklyBossDef;
  progress: number;
  claimed: boolean;
  reward: WeeklyBossDef["reward"];
}

function progressOf(
  db: Db,
  userId: string,
  boss: WeeklyBossDef,
  now: Date,
): number {
  const from = startOfWeek(now);
  if (boss.metric === "quests") {
    const row = db
      .select({ n: sql<number>`COUNT(*)` })
      .from(settlementLog)
      .where(
        and(
          eq(settlementLog.userId, userId),
          eq(settlementLog.kind, "quest_complete"),
          gte(settlementLog.createdAt, from),
        ),
      )
      .get();
    return row?.n ?? 0;
  }
  if (boss.metric === "xp") {
    const row = db
      .select({ n: sql<number>`COALESCE(SUM(${settlementLog.xpAwarded}), 0)` })
      .from(settlementLog)
      .where(
        and(eq(settlementLog.userId, userId), gte(settlementLog.createdAt, from)),
      )
      .get();
    return row?.n ?? 0;
  }
  // checkins：join quests 认签到委托
  const row = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(settlementLog)
    .innerJoin(quests, eq(settlementLog.questId, quests.id))
    .where(
      and(
        eq(settlementLog.userId, userId),
        eq(settlementLog.kind, "quest_complete"),
        eq(quests.checkin, 1),
        gte(settlementLog.createdAt, from),
      ),
    )
    .get();
  return row?.n ?? 0;
}

function claimedThisWeek(db: Db, userId: string, week: string): boolean {
  return (
    db
      .select({ id: settlementLog.id })
      .from(settlementLog)
      .where(
        and(
          eq(settlementLog.userId, userId),
          eq(settlementLog.kind, "weekly_boss"),
          sql`${settlementLog.adjustmentsJson} LIKE ${`%"week":"${week}"%`}`,
        ),
      )
      .all().length > 0
  );
}

export function getWeeklyBossState(
  db: Db,
  userId: string,
  now: Date = new Date(),
): WeeklyBossState {
  const boss = pickWeeklyBoss(now);
  const week = weekKey(now);
  return {
    week,
    boss,
    progress: progressOf(db, userId, boss, now),
    claimed: claimedThisWeek(db, userId, week),
    reward: boss.reward,
  };
}

export interface WeeklyBossClaim {
  boss: WeeklyBossDef;
  week: string;
}

/**
 * 达标则发奖（每周一次）；未达标/已领返回 null。
 * 由对话轮调用（与成就评估同挂载点）。
 */
export function maybeClaimWeeklyBoss(
  db: Db,
  userId: string,
  now: Date = new Date(),
): WeeklyBossClaim | null {
  const state = getWeeklyBossState(db, userId, now);
  if (state.claimed || state.progress < state.boss.target) return null;

  const at = now.getTime();
  const reward = state.boss.reward;
  // 金币 + 道具
  const char = db.select().from(character).where(eq(character.userId, userId)).get();
  if (char) {
    db.update(character)
      .set({ gold: char.gold + reward.gold })
      .where(eq(character.userId, userId))
      .run();
  }
  const existing = db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.itemKey, reward.item)))
    .get();
  if (existing) {
    db.update(items)
      .set({ count: existing.count + reward.item_count })
      .where(eq(items.id, existing.id))
      .run();
  } else {
    db.insert(items)
      .values({
        id: randomUUID(),
        userId,
        itemKey: reward.item,
        count: reward.item_count,
      })
      .run();
  }
  const itemName =
    shopCatalog().find((i) => i.key === reward.item)?.name ?? reward.item;

  db.insert(settlementLog)
    .values({
      id: randomUUID(),
      userId,
      questId: null,
      kind: "weekly_boss",
      completionRatio: null,
      confidence: null,
      xpAwarded: 0,
      goldAwarded: reward.gold,
      attrSplitJson: "{}",
      adjustmentsJson: JSON.stringify({
        week: state.week,
        boss_key: state.boss.key,
        metric: state.boss.metric,
        target: state.boss.target,
        item: reward.item,
        item_count: reward.item_count,
      }),
      llmReasoning: `周常讨伐达成：${state.boss.name}（${state.boss.desc}）`,
      createdAt: at,
    })
    .run();
  db.insert(memory)
    .values({
      id: randomUUID(),
      userId,
      category: "event",
      content: `完成周常讨伐「${state.boss.name}」，奖励 ${reward.gold} 金币与${itemName}×${reward.item_count}`,
      createdAt: at,
    })
    .run();

  return { boss: state.boss, week: state.week };
}
