import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "./util/id";
import type { Db } from "./db";
import { character, quests, settlementLog, titles } from "./db/schema";
import { config } from "./engine/config";
import { levelFromXp, rankFromLevel, rankIndex } from "./engine/leveling";

/**
 * 成就 + 图鉴（V3）
 * - 目录在 economy_config.achievements（配置驱动）；条件由 SQL 从既有数据推导，不新增计数表
 * - 达成后写入 titles（title_key = "ach_<key>"，与突破徽记共用荣誉墙）并留一条
 *   settlement_log（kind="achievement"，0 XP/0 金币），让成就出现在时间线与月账单里
 * - hidden 成就在达成前不暴露名字与描述（API 层打码）
 */

export interface AchievementDef {
  key: string;
  name: string;
  desc: string;
  hidden?: boolean;
  condition: { type: string; value: number };
}

export const ACH_PREFIX = "ach_";

export function achievementCatalog(): AchievementDef[] {
  return config.achievements as AchievementDef[];
}

export function findAchievement(key: string): AchievementDef | null {
  return achievementCatalog().find((a) => a.key === key) ?? null;
}

export interface AchievementStats {
  quests_completed: number;
  streak_max: number;
  gold_earned: number;
  gold_balance: number;
  level: number;
  rank: number;
  gifts_sent: number;
  mainlines_completed: number;
  late_night_settlements: number;
  overdue_recoveries: number;
}

/** 从存量数据推导成就进度（全部只读查询） */
export function computeAchievementStats(db: Db, userId: string): AchievementStats {
  const char = db.select().from(character).where(eq(character.userId, userId)).get();
  const totalLevel = char ? levelFromXp(char.totalXp) : 1;

  const completed = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(quests)
    .where(
      and(
        eq(quests.userId, userId),
        eq(quests.status, "completed"),
        sql`${quests.type} != 'mainline'`,
      ),
    )
    .get();

  const streakMax = db
    .select({ n: sql<number>`COALESCE(MAX(${quests.streak}), 0)` })
    .from(quests)
    .where(eq(quests.userId, userId))
    .get();

  const goldEarned = db
    .select({ n: sql<number>`COALESCE(SUM(CASE WHEN ${settlementLog.goldAwarded} > 0 THEN ${settlementLog.goldAwarded} ELSE 0 END), 0)` })
    .from(settlementLog)
    .where(eq(settlementLog.userId, userId))
    .get();

  const gifts = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(settlementLog)
    .where(and(eq(settlementLog.userId, userId), eq(settlementLog.kind, "gift")))
    .get();

  const mainlines = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(quests)
    .where(
      and(
        eq(quests.userId, userId),
        eq(quests.type, "mainline"),
        eq(quests.status, "completed"),
      ),
    )
    .get();

  const lateNight = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(settlementLog)
    .where(
      and(
        eq(settlementLog.userId, userId),
        eq(settlementLog.kind, "quest_complete"),
        sql`CAST(strftime('%H', ${settlementLog.createdAt} / 1000, 'unixepoch', 'localtime') AS INTEGER) < 4`,
      ),
    )
    .get();

  const recoveries = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(settlementLog)
    .where(
      and(
        eq(settlementLog.userId, userId),
        eq(settlementLog.kind, "quest_complete"),
        sql`${settlementLog.adjustmentsJson} LIKE '%"was_overdue":true%'`,
      ),
    )
    .get();

  return {
    quests_completed: completed?.n ?? 0,
    streak_max: streakMax?.n ?? 0,
    gold_earned: goldEarned?.n ?? 0,
    gold_balance: char?.gold ?? 0,
    level: totalLevel,
    rank: rankIndex(rankFromLevel(totalLevel)),
    gifts_sent: gifts?.n ?? 0,
    mainlines_completed: mainlines?.n ?? 0,
    late_night_settlements: lateNight?.n ?? 0,
    overdue_recoveries: recoveries?.n ?? 0,
  };
}

function conditionMet(condition: AchievementDef["condition"], stats: AchievementStats): boolean {
  const value = (stats as unknown as Record<string, number>)[condition.type];
  return typeof value === "number" && value >= condition.value;
}

export function getOwnedAchievementKeys(db: Db, userId: string): Set<string> {
  return new Set(
    db
      .select({ titleKey: titles.titleKey })
      .from(titles)
      .where(eq(titles.userId, userId))
      .all()
      .map((t) => t.titleKey)
      .filter((k) => k.startsWith(ACH_PREFIX))
      .map((k) => k.slice(ACH_PREFIX.length)),
  );
}

/**
 * 评估并发放新成就（幂等）。返回本次新达成的成就定义。
 * 调用时机：对话轮开始处 + 结算成功后（会长可以在同一轮里提到）。
 */
export function evaluateAchievements(
  db: Db,
  userId: string,
  now = Date.now(),
): AchievementDef[] {
  const owned = getOwnedAchievementKeys(db, userId);
  const pending = achievementCatalog().filter((a) => !owned.has(a.key));
  if (pending.length === 0) return [];

  const stats = computeAchievementStats(db, userId);
  const newly: AchievementDef[] = [];
  for (const ach of pending) {
    if (!conditionMet(ach.condition, stats)) continue;
    db.insert(titles)
      .values({
        id: randomUUID(),
        userId,
        titleKey: `${ACH_PREFIX}${ach.key}`,
        grantedAt: now,
      })
      .run();
    db.insert(settlementLog)
      .values({
        id: randomUUID(),
        userId,
        questId: null,
        kind: "achievement",
        completionRatio: null,
        confidence: null,
        xpAwarded: 0,
        goldAwarded: 0,
        attrSplitJson: "{}",
        adjustmentsJson: JSON.stringify({ achievement_key: ach.key, name: ach.name }),
        llmReasoning: ach.desc,
        createdAt: now,
      })
      .run();
    newly.push(ach);
  }
  return newly;
}

export interface AchievementView extends AchievementDef {
  owned: boolean;
  unlockedAt: number | null;
}

/** 图鉴数据（hidden 未达成时打码） */
export function listAchievements(
  db: Db,
  userId: string,
): { achievements: AchievementView[]; owned: number; total: number } {
  const rows = db
    .select({ titleKey: titles.titleKey, grantedAt: titles.grantedAt })
    .from(titles)
    .where(eq(titles.userId, userId))
    .all();
  const ownedMap = new Map(
    rows
      .filter((r) => r.titleKey.startsWith(ACH_PREFIX))
      .map((r) => [r.titleKey.slice(ACH_PREFIX.length), r.grantedAt]),
  );
  const achievements = achievementCatalog().map((a) => {
    const ownedAt = ownedMap.get(a.key) ?? null;
    const owned = ownedAt != null;
    if (a.hidden && !owned) {
      return { ...a, name: "？？？", desc: "达成后揭晓", owned, unlockedAt: null };
    }
    return { ...a, owned, unlockedAt: ownedAt };
  });
  return {
    achievements,
    owned: achievements.filter((a) => a.owned).length,
    total: achievements.length,
  };
}
