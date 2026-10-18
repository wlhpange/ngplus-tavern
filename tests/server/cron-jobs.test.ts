import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../../src/server/db";
import { items, quests, settlementLog } from "../../src/server/db/schema";
import { runOverdueSweep } from "../../src/server/cron/jobs";
import { REST_SCROLL_KEY } from "../../src/server/shop";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function makeQuest(overrides: Partial<typeof quests.$inferInsert> = {}) {
  const id = overrides.id ?? `q_${randomUUID().slice(0, 8)}`;
  db.insert(quests)
    .values({
      id,
      userId,
      title: "晨跑 3 公里",
      type: "daily",
      primaryAttr: "vitality",
      primaryWeight: 1.0,
      difficulty: 1,
      status: "active",
      streak: 0,
      createdAt: Date.now(),
      ...overrides,
    })
    .run();
  return id;
}

/** 构造"某天的某个时刻"，便于精确控制时间窗 */
function at(y: number, m: number, d: number, h: number, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/** 给用户发 n 张休整卷轴 */
function grantScrolls(n: number) {
  db.insert(items)
    .values({ id: randomUUID(), userId, itemKey: REST_SCROLL_KEY, count: n })
    .run();
}

// ------------------------------------------------------------ 逾期巡检

describe("逾期巡检 · 断签规则（M5，AGENTS.md §7）", () => {
  it("昨日未结算 → 首次断签：streak 保留、break_streak=1、置 overdue", async () => {
    const id = makeQuest({ streak: 10 });
    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.scanned).toBe(1);
    expect(r.mutated).toBe(1);

    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.status).toBe("overdue");
    expect(q.streak).toBe(10); // 首次断签不清零
    expect(q.breakStreak).toBe(1);
  });

  it("昨日已结算 → 不断签；顺带清掉历史 break_streak", async () => {
    const id = makeQuest({ streak: 3, breakStreak: 1 });
    // 昨日 20:00 有一条结算记录
    db.insert(settlementLog)
      .values({
        id: randomUUID(),
        userId,
        questId: id,
        kind: "quest_complete",
        xpAwarded: 10,
        goldAwarded: 5,
        attrSplitJson: "{}",
        createdAt: at(2026, 9, 8, 20).getTime(),
      })
      .run();

    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.mutated).toBe(1); // 仅清 break_streak
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.status).toBe("active");
    expect(q.streak).toBe(3);
    expect(q.breakStreak).toBe(0);
  });

  it("连续第二天再断 → streak 清零、break_streak 归零", async () => {
    const id = makeQuest({ streak: 10, breakStreak: 1 });
    // 前一天的巡检已把任务置 overdue；用户没汇报 → 今日仍未结算
    db.update(quests).set({ status: "active", lastCheckedAt: at(2026, 9, 8, 1).getTime() })
      .where(eq(quests.id, id)).run();

    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.mutated).toBe(1);
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.streak).toBe(0);
    expect(q.breakStreak).toBe(0);
    expect(q.status).toBe("overdue");
  });

  it("同一天重复巡检不重复惩罚（last_checked_at 幂等）", async () => {
    const id = makeQuest({ streak: 5 });
    const first = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(first.mutated).toBe(1);
    const second = await runOverdueSweep(db, at(2026, 9, 9, 1, 30));
    expect(second.mutated).toBe(0);
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.breakStreak).toBe(1);
  });

  it("非 daily 任务不参与断签", async () => {
    const id = makeQuest({ type: "once", streak: 3 });
    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.scanned).toBe(0);
    expect(r.mutated).toBe(0);
    expect(db.select().from(quests).where(eq(quests.id, id)).get()!.status).toBe("active");
  });

  it("非巡检时刻不执行", async () => {
    makeQuest();
    const r = await runOverdueSweep(db, at(2026, 9, 9, 12));
    expect(r.scanned).toBe(0);
  });
});

// -------------------------------------------------- 休整卷轴 · 断签保全（V1.5）

describe("逾期巡检 · 休整卷轴断签保全（V1.5）", () => {
  it("持有卷轴：断签被保全，streak/break_streak 不动，卷轴消耗一张", async () => {
    const id = makeQuest({ streak: 10 });
    grantScrolls(1);

    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.mutated).toBe(1);

    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.status).toBe("overdue"); // 该没做还是没做
    expect(q.streak).toBe(10); // 连击完全保全
    expect(q.breakStreak).toBe(0); // 不记断签

    const scroll = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, REST_SCROLL_KEY))).get()!;
    expect(scroll.count).toBe(0);
  });

  it("卷轴数量不足：先到的任务被保全，后面的照常断签", async () => {
    const saved = makeQuest({ title: "晨跑", streak: 8 });
    const broken = makeQuest({ title: "背单词", streak: 5 });
    grantScrolls(1);

    const r = await runOverdueSweep(db, at(2026, 9, 9, 1));
    expect(r.mutated).toBe(2);

    const qSaved = db.select().from(quests).where(eq(quests.id, saved)).get()!;
    expect(qSaved.streak).toBe(8);
    expect(qSaved.breakStreak).toBe(0);

    const qBroken = db.select().from(quests).where(eq(quests.id, broken)).get()!;
    expect(qBroken.streak).toBe(5);
    expect(qBroken.breakStreak).toBe(1); // 正常断签

    const scroll = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, REST_SCROLL_KEY))).get()!;
    expect(scroll.count).toBe(0);
  });

  it("同日重复巡检不重复消耗卷轴（last_checked_at 幂等）", async () => {
    makeQuest({ streak: 6 });
    grantScrolls(2);
    await runOverdueSweep(db, at(2026, 9, 9, 1));
    const second = await runOverdueSweep(db, at(2026, 9, 9, 1, 30));
    expect(second.mutated).toBe(0);
    const scroll = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, REST_SCROLL_KEY))).get()!;
    expect(scroll.count).toBe(1); // 只消耗了一张
  });

  it("未持有卷轴：照常断签（既有软机制不受影响）", async () => {
    const id = makeQuest({ streak: 4 });
    await runOverdueSweep(db, at(2026, 9, 9, 1));
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.streak).toBe(4);
    expect(q.breakStreak).toBe(1);
  });
});
