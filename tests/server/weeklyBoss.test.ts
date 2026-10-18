import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { character, items, memory, quests, settlementLog } from "../../src/server/db/schema";
import {
  getWeeklyBossState,
  maybeClaimWeeklyBoss,
  pickWeeklyBoss,
  weeklyBossPool,
} from "../../src/server/weeklyBoss";
import { startOfWeek, weekKey } from "../../src/server/util/time";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

/** 固定周三（本地时区），方便断言"同一周" */
const WED = new Date(2026, 8, 23, 12, 0, 0);
const NEXT_WED = new Date(2026, 8, 30, 12, 0, 0);

function addSettlement(id: string, at: number, opts: Partial<typeof settlementLog.$inferInsert> = {}) {
  db.insert(settlementLog)
    .values({
      id,
      userId,
      questId: null,
      kind: "quest_complete",
      xpAwarded: 10,
      goldAwarded: 5,
      attrSplitJson: "{}",
      createdAt: at,
      ...opts,
    })
    .run();
}

/** 塞满所有指标：5 件委托（含 3 次签到，合计 400 XP）都在本周内 */
function seedAllMetrics(at: number) {
  const checkinQuestId = `q_checkin_${at}`;
  db.insert(quests)
    .values({
      id: checkinQuestId,
      userId,
      title: "签到委托",
      type: "daily",
      primaryAttr: "mind",
      status: "active",
      checkin: 1,
      createdAt: at,
    })
    .run();
  for (let i = 0; i < 5; i++) {
    addSettlement(`s${at}_${i}`, at + i * 1000, {
      xpAwarded: 80,
      questId: i < 3 ? checkinQuestId : null,
    });
  }
}

describe("周常 Boss · 选取与周键", () => {
  it("同一周内稳定指向同一只，周键为周一日期", () => {
    const a = pickWeeklyBoss(WED);
    const b = pickWeeklyBoss(new Date(2026, 8, 27, 23, 0)); // 同周周日
    expect(a.key).toBe(b.key);
    expect(weekKey(WED)).toBe("2026-09-21");
    expect(weeklyBossPool().map((p) => p.key)).toContain(a.key);
  });

  it("进度从本周结算推导：上周的数据不计入", () => {
    const weekStart = startOfWeek(WED);
    seedAllMetrics(weekStart + 3600_000);
    // 上周的 10 件，全部不该计入
    for (let i = 0; i < 10; i++) {
      addSettlement(`old${i}`, weekStart - 86_400_000 - i * 1000, { xpAwarded: 80 });
    }
    const state = getWeeklyBossState(db, userId, WED);
    expect(state.progress).toBeGreaterThanOrEqual(
      Math.min(state.boss.target, state.boss.metric === "quests" ? 5 : 3),
    );
    expect(state.progress).toBeLessThanOrEqual(5);
    expect(state.claimed).toBe(false);
  });
});

describe("周常 Boss · 领奖", () => {
  it("未达标不发放", () => {
    addSettlement("s1", WED.getTime());
    expect(maybeClaimWeeklyBoss(db, userId, WED)).toBeNull();
  });

  it("达标发放：金币 + 道具 + 留痕 + 记忆，且每周只发一次", () => {
    const weekStart = startOfWeek(WED);
    seedAllMetrics(weekStart + 3600_000);
    const before = db.select().from(character).where(eq(character.userId, userId)).get()!;
    const itemBefore = db.select().from(items).all().length;

    const claim = maybeClaimWeeklyBoss(db, userId, WED);
    expect(claim).not.toBeNull();
    const reward = claim!.boss.reward;

    const after = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(after.gold).toBe(before.gold + reward.gold);

    const stock = db
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, reward.item)))
      .get();
    expect(stock?.count).toBe(reward.item_count);
    expect(db.select().from(items).all().length).toBeGreaterThanOrEqual(itemBefore);

    const log = db
      .select()
      .from(settlementLog)
      .where(eq(settlementLog.kind, "weekly_boss"))
      .get()!;
    expect(log.goldAwarded).toBe(reward.gold);
    expect(JSON.parse(log.adjustmentsJson!).week).toBe("2026-09-21");

    expect(db.select().from(memory).all().some((m) => m.content.includes("周常"))).toBe(true);

    // 幂等：同周再调不重复发
    expect(maybeClaimWeeklyBoss(db, userId, WED)).toBeNull();

    // 下周重置（新周不继承"已领"）
    const nextState = getWeeklyBossState(db, userId, NEXT_WED);
    expect(nextState.claimed).toBe(false);
    expect(nextState.week).toBe("2026-09-28");
  });
});
