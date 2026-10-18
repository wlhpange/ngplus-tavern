import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { character, dailyEvents, settlementLog } from "../../src/server/db/schema";
import {
  dailyEventCatalog,
  dailyEventNarrative,
  dailyFirstSettlementXpRatio,
  dailyGoldRatio,
  getTodayEvent,
  rollDailyEvent,
  shopDiscountFor,
} from "../../src/server/dailyEvent";
import { purchaseItem } from "../../src/server/shop";
import { settleQuest } from "../../src/server/engine/settlement";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function queueRand(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function forceEvent(
  eventKey: string,
  payload: Record<string, unknown> = {},
  at: Date = new Date(),
) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  db.insert(dailyEvents)
    .values({
      id: `ev_${eventKey}`,
      userId,
      dayKey: `${y}-${m}-${d}`,
      eventKey,
      payloadJson: JSON.stringify(payload),
      createdAt: at.getTime(),
    })
    .run();
}

describe("每日事件掷骰", () => {
  it("概率未命中：不产生事件", () => {
    const r = rollDailyEvent(db, userId, new Date(), () => 0.99);
    expect(r.event).toBeNull();
    expect(db.select().from(dailyEvents).all()).toHaveLength(0);
  });

  it("命中：产生事件并落库；当天再掷返回同一条（fresh=false）", () => {
    const rand = queueRand([0.0, 0.0, 0.0]); // chance 命中 → 选第 1 个事件 → 折扣商品选第 1 件
    const r1 = rollDailyEvent(db, userId, new Date(), rand);
    expect(r1.event).not.toBeNull();
    expect(r1.fresh).toBe(true);
    expect(dailyEventCatalog().map((e) => e.key)).toContain(r1.event!.key);

    const r2 = rollDailyEvent(db, userId, new Date(), () => 0.99);
    expect(r2.fresh).toBe(false);
    expect(r2.event?.key).toBe(r1.event!.key);
    expect(db.select().from(dailyEvents).all()).toHaveLength(1);
  });

  it("只认当天：昨天的记录不算今天的事件", () => {
    forceEvent("masters_mood", {}, new Date(Date.now() - 86_400_000));
    expect(getTodayEvent(db, userId)).toBeNull();
  });
});

describe("事件效果", () => {
  it("旅商折扣：命中商品才有折后价，购买按折后价扣款", () => {
    db.update(character).set({ gold: 200 }).where(eq(character.userId, userId)).run();
    forceEvent("traveling_merchant", { item_key: "gift_tea" });
    const tea = { key: "gift_tea", price: 50 };
    const info = shopDiscountFor(db, userId, tea)!;
    expect(info.ratio).toBeCloseTo(0.2);
    expect(info.priceAfter).toBe(40);
    expect(shopDiscountFor(db, userId, { key: "gift_book", price: 120 })).toBeNull();

    const r = purchaseItem(db, userId, "gift_tea");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.price).toBe(40);
    expect(r.receipt.discountRatio).toBeCloseTo(0.2);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(160);
    const log = db.select().from(settlementLog).where(eq(settlementLog.kind, "purchase")).get()!;
    expect(log.goldAwarded).toBe(-40);
    expect(JSON.parse(log.adjustmentsJson!).discount_ratio).toBeCloseTo(0.2);
  });

  it("会长心情：结算金币加成比例可读", () => {
    expect(dailyGoldRatio(db, userId)).toBe(0);
    forceEvent("masters_mood");
    expect(dailyGoldRatio(db, userId)).toBeCloseTo(0.15);
  });

  it("星夜：只对当天第一笔结算返回加成", () => {
    forceEvent("starry_night");
    expect(dailyFirstSettlementXpRatio(db, userId)).toBeCloseTo(0.2);
    db.insert(settlementLog)
      .values({
        id: "s1",
        userId,
        questId: null,
        kind: "quest_complete",
        xpAwarded: 10,
        goldAwarded: 0,
        attrSplitJson: "{}",
        createdAt: Date.now(),
      })
      .run();
    expect(dailyFirstSettlementXpRatio(db, userId)).toBe(0);
  });

  it("星夜加成乘在软上限之前：xpBonusRatio 生效且属性合计不破", () => {
    const base = settleQuest({
      type: "once", difficulty: 1, streak: 0, completionRatio: 1,
      primaryAttr: "mind", todaySettledXp: 0,
    });
    const boosted = settleQuest({
      type: "once", difficulty: 1, streak: 0, completionRatio: 1,
      primaryAttr: "mind", todaySettledXp: 0, xpBonusRatio: 0.2,
    });
    expect(boosted.xpAwarded).toBe(Math.round(base.xpAwarded * 1.2));
    const sum = Object.values(boosted.attrSplit).reduce((a, b) => a + b, 0);
    expect(sum).toBe(boosted.xpAwarded);
  });

  it("叙事文本：折扣事件带商品名", () => {
    forceEvent("traveling_merchant", { item_key: "gift_book" });
    const ev = getTodayEvent(db, userId)!;
    expect(dailyEventNarrative(ev)).toContain("旅商过境");
    expect(dailyEventNarrative(ev)).toContain("一本旧书");
  });
});
