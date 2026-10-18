import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { character, quests, settlementLog, titles } from "../../src/server/db/schema";
import {
  achievementCatalog,
  computeAchievementStats,
  evaluateAchievements,
  listAchievements,
} from "../../src/server/achievements";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function addCompletedQuest(id: string, opts: Partial<typeof quests.$inferInsert> = {}) {
  db.insert(quests)
    .values({
      id,
      userId,
      title: `委托 ${id}`,
      type: "once",
      primaryAttr: "mind",
      status: "completed",
      completedAt: Date.now(),
      createdAt: Date.now(),
      ...opts,
    })
    .run();
}

function addSettlement(
  id: string,
  opts: Partial<typeof settlementLog.$inferInsert> = {},
) {
  db.insert(settlementLog)
    .values({
      id,
      userId,
      questId: null,
      kind: "quest_complete",
      xpAwarded: 0,
      goldAwarded: 0,
      attrSplitJson: "{}",
      createdAt: Date.now(),
      ...opts,
    })
    .run();
}

describe("成就目录（economy_config.achievements）", () => {
  it("14 项成就，其中 2 项隐藏", () => {
    const catalog = achievementCatalog();
    expect(catalog).toHaveLength(14);
    expect(catalog.filter((a) => a.hidden).map((a) => a.key)).toEqual([
      "night_owl",
      "comeback",
    ]);
  });
});

describe("达成评估（evaluateAchievements）", () => {
  it("新档案：暂无成就", () => {
    expect(evaluateAchievements(db, userId)).toEqual([]);
    expect(db.select().from(titles).all()).toHaveLength(0);
  });

  it("十件委托 + 送礼 + 赚到 1000 金：一次发放 4 项，重复调用为空（幂等）", () => {
    for (let i = 0; i < 12; i++) addCompletedQuest(`q${i}`);
    addSettlement("s_gift", { kind: "gift" });
    addSettlement("s_gold", { goldAwarded: 1200 });

    const newly = evaluateAchievements(db, userId).map((a) => a.key);
    expect(newly).toEqual(
      expect.arrayContaining(["first_quest", "ten_quests", "first_gold", "first_gift"]),
    );
    // 幂等：再来一次不重复发
    expect(evaluateAchievements(db, userId)).toEqual([]);
    const achTitles = db
      .select()
      .from(titles)
      .all()
      .filter((t) => t.titleKey.startsWith("ach_"));
    expect(achTitles).toHaveLength(newly.length);
    // 成就也进结算流水（时间线/月账单可见）
    expect(
      db
        .select()
        .from(settlementLog)
        .all()
        .filter((l) => l.kind === "achievement").length,
    ).toBe(newly.length);
  });

  it("评级与等级：Lv.10 同时拿下「双位数」与「评级 · D」", () => {
    // Lv.10 需要累计 4950 XP
    db.update(character)
      .set({ totalXp: 4950 })
      .where(eq(character.userId, userId))
      .run();
    const newly = evaluateAchievements(db, userId).map((a) => a.key);
    expect(newly).toContain("level_10");
    expect(newly).toContain("rank_d");
  });

  it("隐藏成就：凌晨结算拿「夜航」，逾期补结算拿「接回来了」", () => {
    const lateNight = new Date();
    lateNight.setHours(2, 30, 0, 0);
    addSettlement("s_night", { createdAt: lateNight.getTime() });
    addSettlement("s_comeback", {
      adjustmentsJson: JSON.stringify({ was_overdue: true }),
    });
    const newly = evaluateAchievements(db, userId).map((a) => a.key);
    expect(newly).toContain("night_owl");
    expect(newly).toContain("comeback");
  });

  it("连击成就：streak 7 拿「七日不熄」", () => {
    addCompletedQuest("q_streak", { type: "daily", streak: 7, status: "active", completedAt: null });
    expect(evaluateAchievements(db, userId).map((a) => a.key)).toContain("streak_7");
  });
});

describe("图鉴数据（listAchievements）", () => {
  it("未达成的隐藏成就打码；达成后揭晓", () => {
    const before = listAchievements(db, userId);
    const owl = before.achievements.find((a) => a.key === "night_owl")!;
    expect(owl.owned).toBe(false);
    expect(owl.name).toBe("？？？");
    expect(before.total).toBe(14);
    expect(before.owned).toBe(0);

    const lateNight = new Date();
    lateNight.setHours(1, 0, 0, 0);
    addSettlement("s_night", { createdAt: lateNight.getTime() });
    evaluateAchievements(db, userId);

    const after = listAchievements(db, userId);
    const owl2 = after.achievements.find((a) => a.key === "night_owl")!;
    expect(owl2.owned).toBe(true);
    expect(owl2.name).toBe("夜航");
    expect(owl2.unlockedAt).not.toBeNull();
    expect(after.owned).toBeGreaterThan(0);
  });
});

describe("进度统计（computeAchievementStats）", () => {
  it("主线完成与里程碑分开计数（里程碑不算主线）", () => {
    addCompletedQuest("m1", { type: "mainline" });
    addCompletedQuest("m2", { type: "mainline_milestone" });
    addCompletedQuest("q1");
    const stats = computeAchievementStats(db, userId);
    expect(stats.mainlines_completed).toBe(1);
    expect(stats.quests_completed).toBe(2); // 普通 + 里程碑，不算主线
  });
});
