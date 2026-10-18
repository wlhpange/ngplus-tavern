import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { items, memory, settlementLog, titles } from "../../src/server/db/schema";
import { applyRankPromotion } from "../../src/server/rankPromotion";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

describe("评级突破（applyRankPromotion）", () => {
  it("未跨过阈值：什么都不发生", () => {
    const r = applyRankPromotion(db, userId, 100, 120, null, "测试");
    expect(r).toEqual({ gold: 0, note: "", from: null, to: null, items: [] });
    expect(db.select().from(titles).all()).toHaveLength(0);
    expect(db.select().from(items).all()).toHaveLength(0);
  });

  it("F → E 突破：酬金 400 + 突破礼（休整卷轴 ×1）+ 徽记 + 留痕 + 记忆", () => {
    // Lv.5（评级 E）需要累计 1200 XP；1195 → 1220 跨过
    const r = applyRankPromotion(db, userId, 1195, 1220, null, "复核追加触发");
    expect(r.from).toBe("F");
    expect(r.to).toBe("E");
    expect(r.gold).toBe(400); // 序数 2 × 200
    expect(r.items).toEqual([{ key: "rest_scroll", name: "休整卷轴", count: 1 }]);

    const stock = db
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, "rest_scroll")))
      .get()!;
    expect(stock.count).toBe(1);

    expect(
      db.select().from(titles).all().map((t) => t.titleKey),
    ).toContain("rank_E");

    const log = db.select().from(settlementLog).where(eq(settlementLog.kind, "title_grant")).get()!;
    expect(log.goldAwarded).toBe(400);
    expect(JSON.parse(log.adjustmentsJson!)).toMatchObject({
      breakthrough: { from: "F", to: "E" },
    });

    const mem = db.select().from(memory).all();
    expect(mem.some((m) => m.content.includes("突破：评级 F → E"))).toBe(true);
  });

  it("跨多段：一次性结算到最终评级，休整卷轴只发一份", () => {
    // Lv.10（评级 D）需要累计 4950 XP；1195 → 5000 从 F 直接跨到 D
    const r = applyRankPromotion(db, userId, 1195, 5000, null, "大额追加");
    expect(r.from).toBe("F");
    expect(r.to).toBe("D");
    const stock = db
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, "rest_scroll")))
      .get()!;
    expect(stock.count).toBe(1); // 一次调用只发一份
  });
});
