import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "../llm/helpers";
import {
  rankBadgeInfo,
  allRanks,
  levelFromXp,
} from "../../src/server/engine/leveling";
import {
  getCharacterSummary,
  getMonthSummary,
  getRecentSettlements,
  getSettlementsInRange,
  getSettlementsSince,
} from "../../src/server/character";
import { quests, settlementLog, titles } from "../../src/server/db/schema";

describe("评级徽章（rankBadgeInfo，阈值读 economy_config.json）", () => {
  it("Lv.1 → F，距 E 还需 4 级", () => {
    const b = rankBadgeInfo(1);
    expect(b.current).toBe("F");
    expect(b.next).toEqual({ rank: "E", levelsNeeded: 4 });
  });

  it("Lv.5 → E，距 D 还需 5 级", () => {
    const b = rankBadgeInfo(5);
    expect(b.current).toBe("E");
    expect(b.next).toEqual({ rank: "D", levelsNeeded: 5 });
  });

  it("评级边界：Lv.9=E / Lv.10=D / Lv.41=S 且无下一评级", () => {
    expect(rankBadgeInfo(9).current).toBe("E");
    expect(rankBadgeInfo(10).current).toBe("D");
    const s = rankBadgeInfo(41);
    expect(s.current).toBe("S");
    expect(s.next).toBeNull();
  });

  it("徽章列表覆盖 F→S 七档", () => {
    expect(allRanks().map((r) => r.rank)).toEqual([
      "F",
      "E",
      "D",
      "C",
      "B",
      "A",
      "S",
    ]);
  });
});

describe("称号解锁查询（getCharacterSummary）", () => {
  it("titles 表授予的称号按授予时间倒序出现在面板数据中", () => {
    const { db, userId } = createTestDb();
    const now = Date.now();
    db.insert(titles)
      .values({ id: randomUUID(), userId, titleKey: "first_gold", grantedAt: now - 1000 })
      .run();
    db.insert(titles)
      .values({ id: randomUUID(), userId, titleKey: "streak_7", grantedAt: now })
      .run();
    const summary = getCharacterSummary(db, userId);
    expect(summary.titles).toEqual(["streak_7", "first_gold"]);
  });
});

describe("结算历史（getRecentSettlements，与 settlement_log 对账）", () => {
  it("联表任务标题、解析属性分流、按时间倒序", () => {
    const { db, userId } = createTestDb();
    const now = Date.now();
    const questId = randomUUID();
    db.insert(quests)
      .values({
        id: questId,
        userId,
        title: "晨跑 3 公里",
        type: "daily",
        primaryAttr: "vitality",
        createdAt: now,
      })
      .run();
    db.insert(settlementLog)
      .values({
        id: randomUUID(),
        userId,
        questId,
        kind: "quest_complete",
        completionRatio: 1,
        confidence: 0.9,
        xpAwarded: 10,
        goldAwarded: 5,
        attrSplitJson: JSON.stringify({ vitality: 8, willpower: 2 }),
        createdAt: now - 1000,
      })
      .run();
    db.insert(settlementLog)
      .values({
        id: randomUUID(),
        userId,
        questId: null,
        kind: "level_up",
        xpAwarded: 0,
        goldAwarded: 0,
        attrSplitJson: "{}",
        createdAt: now,
      })
      .run();

    const list = getRecentSettlements(db, userId);
    expect(list).toHaveLength(2);
    // 倒序：最新在前
    expect(list[0].kind).toBe("level_up");
    expect(list[0].questTitle).toBeNull();
    expect(list[1].questTitle).toBe("晨跑 3 公里");
    expect(list[1].attrSplit).toEqual({ vitality: 8, willpower: 2 });
  });

  it("对账一致：quest_complete 历史的 XP/金币累计 = character 表现值", () => {
    const { db, userId } = createTestDb();
    const now = Date.now();
    const questId = randomUUID();
    db.insert(quests)
      .values({
        id: questId,
        userId,
        title: "背单词",
        type: "daily",
        primaryAttr: "mind",
        createdAt: now,
      })
      .run();
    // 两笔结算，直接落到 character（模拟引擎行为）
    for (const [xp, gold] of [
      [10, 5],
      [12, 5],
    ] as const) {
      db.insert(settlementLog)
        .values({
          id: randomUUID(),
          userId,
          questId,
          kind: "quest_complete",
          xpAwarded: xp,
          goldAwarded: gold,
          attrSplitJson: JSON.stringify({ mind: xp }),
          createdAt: now,
        })
        .run();
    }
    // better-sqlite3 原生句柄悬挂在 drizzle 实例的 $client 上（类型未公开）
    (
      db as unknown as {
        $client: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }
    ).$client
      .prepare("UPDATE character SET total_xp = 22, gold = 10, mind_xp = 22 WHERE user_id = ?")
      .run(userId);

    const list = getRecentSettlements(db, userId);
    const xpSum = list.reduce((s, r) => s + r.xpAwarded, 0);
    const goldSum = list.reduce((s, r) => s + r.goldAwarded, 0);
    const summary = getCharacterSummary(db, userId);
    expect(xpSum).toBe(summary.totalXp);
    expect(goldSum).toBe(summary.gold);
    expect(summary.attrs.mind.xp).toBe(22);
    expect(summary.totalLevel).toBe(levelFromXp(22));
  });
});

describe("结算时间窗查询（V2.0 对话卡片流）", () => {
  it("getSettlementsInRange 取 [from,to) 正序；getSettlementsSince 取 from 之后正序", () => {
    const { db, userId } = createTestDb();
    const base = Date.now();
    for (const [id, at] of [
      ["s1", base - 30_000],
      ["s2", base - 20_000],
      ["s3", base - 10_000],
      ["s4", base],
    ] as const) {
      db.insert(settlementLog)
        .values({
          id,
          userId,
          questId: null,
          kind: "level_up",
          xpAwarded: 0,
          goldAwarded: 0,
          attrSplitJson: "{}",
          createdAt: at,
        })
        .run();
    }
    const range = getSettlementsInRange(db, userId, base - 25_000, base - 5_000);
    expect(range.map((r) => r.id)).toEqual(["s2", "s3"]);

    const since = getSettlementsSince(db, userId, base - 15_000);
    expect(since.map((r) => r.id)).toEqual(["s3", "s4"]);
  });
});

describe("本月汇总（getMonthSummary，月账单抬头）", () => {
  it("只统计本自然月的 xp 合计 / 金币合计 / 笔数", () => {
    const { db, userId } = createTestDb();
    const now = new Date(2026, 8, 27, 12, 0);
    const inMonth = new Date(2026, 8, 3, 9, 0).getTime();
    const lastMonth = new Date(2026, 7, 31, 23, 0).getTime();
    const rows = [
      { id: "s1", at: inMonth, xp: 30, gold: 10 },
      { id: "s2", at: inMonth + 1000, xp: 12, gold: -50 },
      { id: "s3", at: lastMonth, xp: 999, gold: 999 },
    ];
    for (const r of rows) {
      db.insert(settlementLog)
        .values({
          id: r.id,
          userId,
          questId: null,
          kind: "quest_complete",
          xpAwarded: r.xp,
          goldAwarded: r.gold,
          attrSplitJson: "{}",
          createdAt: r.at,
        })
        .run();
    }
    const s = getMonthSummary(db, userId, now);
    expect(s.xp).toBe(42);
    expect(s.gold).toBe(-40);
    expect(s.count).toBe(2);
  });
});
