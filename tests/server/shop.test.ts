import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { character, items, memory, settlementLog, saves, masterHistory } from "../../src/server/db/schema";
import {
  purchaseItem,
  giftItem,
  itemUnlockState,
  shopCatalog,
  findShopItem,
  REST_SCROLL_KEY,
} from "../../src/server/shop";
import { createTestDb } from "../llm/helpers";
import { getAffinity } from "../../src/server/masters";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

/** 给测试用户充金币 */
function setGold(gold: number) {
  db.update(character).set({ gold }).where(eq(character.userId, userId)).run();
}

describe("协会商店（V1.5 金币消耗口）", () => {
  it("目录来自 economy_config（卷轴 100 / 礼物 50-1200；皮肤类目已收敛移除）", () => {
    const catalog = shopCatalog();
    const scroll = findShopItem(REST_SCROLL_KEY)!;
    expect(scroll.price).toBe(100);
    expect(scroll.type).toBe("consumable");
    const prices = catalog.map((i) => i.price);
    expect(Math.min(...prices)).toBe(50);
    expect(Math.max(...prices)).toBe(1200);
    expect(catalog.find((i) => i.key.startsWith("skin_"))).toBeUndefined();
    // 金币铁律：商店里没有任何数值型商品（每件都带名字与描述）
    for (const item of catalog) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
      expect(["consumable", "gift"]).toContain(item.type);
    }
  });

  it("购买休整卷轴：扣款、入袋、留痕，对账闭合（金币 = Σ gold_awarded）", () => {
    setGold(150);
    const r = purchaseItem(db, userId, REST_SCROLL_KEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.goldLeft).toBe(50);
    expect(r.receipt.count).toBe(1);

    const stock = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, REST_SCROLL_KEY))).get()!;
    expect(stock.count).toBe(1);

    const log = db.select().from(settlementLog)
      .where(eq(settlementLog.kind, "purchase")).all();
    expect(log).toHaveLength(1);
    expect(log[0].goldAwarded).toBe(-100);
    expect(JSON.parse(log[0].adjustmentsJson!)).toMatchObject({ item_key: REST_SCROLL_KEY });

    // 对账不变式：购买后金币（50）= 初始 150 + 累计结算（-100）
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    const totalGold = log.reduce((s, l) => s + l.goldAwarded, 0);
    expect(150 + totalGold).toBe(c.gold);
  });

  it("金币不足：拒绝购买，不改任何状态", () => {
    setGold(99);
    const r = purchaseItem(db, userId, REST_SCROLL_KEY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("金币不够");
    expect(db.select().from(settlementLog).where(eq(settlementLog.kind, "purchase")).all()).toHaveLength(0);
    expect(db.select().from(items).all()).toHaveLength(0);
  });

  it("未知商品拒绝", () => {
    const r = purchaseItem(db, userId, "phoenix_feather");
    expect(r.ok).toBe(false);
  });

  it("卷轴可囤多张（应急储备）", () => {
    setGold(300);
    expect(purchaseItem(db, userId, REST_SCROLL_KEY).ok).toBe(true);
    const r2 = purchaseItem(db, userId, REST_SCROLL_KEY);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.receipt.count).toBe(2);
    expect(r2.receipt.goldLeft).toBe(100);
  });

  it("礼物购买：入袋留痕，不落记忆（赠送才是动作，V2.0）", () => {
    // 旧书 V3 起要 Lv.3：先升到 Lv.3（400 XP 起）
    db.update(character).set({ totalXp: 500 }).where(eq(character.userId, userId)).run();
    setGold(500);
    const r = purchaseItem(db, userId, "gift_book");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.count).toBe(1);
    const stock = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, "gift_book"))).get()!;
    expect(stock.count).toBe(1);
    expect(db.select().from(memory).all()).toHaveLength(0);
  });

  it("存档缺失时购买/装备都拒绝", () => {
    // saves 被 master_history 外键引用，先清引用方再清存档，模拟"存档缺失"
    db.delete(masterHistory).run();
    db.delete(saves).run();
    expect(purchaseItem(db, userId, REST_SCROLL_KEY).ok).toBe(false);
  });
});

describe("礼物赠送 + 亲密度推进（V2.0）", () => {
  function giftStock(key: string, count: number) {
    const existing = db.select().from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, key))).get();
    if (existing) {
      db.update(items).set({ count }).where(eq(items.id, existing.id)).run();
    } else {
      db.insert(items).values({ id: `it_${key}`, userId, itemKey: key, count }).run();
    }
  }

  it("抽屉里没有存货：拒绝且不改任何状态", () => {
    const r = giftItem(db, userId, "gift_tea");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("抽屉里没有");
    expect(db.select().from(settlementLog).all()).toHaveLength(0);
    expect(db.select().from(memory).all()).toHaveLength(0);
  });

  it("赠送一盏热茶：消耗一份、+1 亲密度、落记忆与 gift 留痕（不动金币）", () => {
    giftStock("gift_tea", 2);
    const r = giftItem(db, userId, "gift_tea");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.countLeft).toBe(1);
    expect(r.receipt.points).toBe(1);
    expect(r.receipt.intimacyStage).toBe(1);
    expect(r.receipt.stageUp).toBe(false);

    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    const affinity = getAffinity(db, userId, save.activeMasterId!);
    expect(affinity.points).toBe(1);

    const log = db.select().from(settlementLog).where(eq(settlementLog.kind, "gift")).all();
    expect(log).toHaveLength(1);
    expect(log[0].goldAwarded).toBe(0);
    expect(JSON.parse(log[0].adjustmentsJson!)).toMatchObject({ item_key: "gift_tea", intimacy_points: 1 });

    const mem = db.select().from(memory).where(eq(memory.category, "event")).all();
    expect(mem).toHaveLength(1);
    expect(mem[0].content).toContain("热茶");

    // 金币对账不变式不受礼物影响
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(0);
  });

  it("跨过阈值：阶段提升到「熟络」，记忆带阶段标注", () => {
    giftStock("gift_tea", 8);
    let last: ReturnType<typeof giftItem> | null = null;
    for (let i = 0; i < 8; i++) last = giftItem(db, userId, "gift_tea");
    expect(last!.ok).toBe(true);
    if (!last!.ok) return;
    expect(last!.receipt.stageUp).toBe(true);
    expect(last!.receipt.intimacyStage).toBe(2);
    expect(last!.receipt.intimacyLabel).toBe("熟络");
    expect(last!.receipt.countLeft).toBe(0);

    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    const affinity = getAffinity(db, userId, save.activeMasterId!);
    expect(affinity.stage).toBe(2);
    expect(affinity.points).toBe(8);

    const mem = db.select().from(memory).all();
    expect(mem.some((m) => m.content.includes("熟络"))).toBe(true);
    expect(mem).toHaveLength(8);
  });

  it("休整卷轴不是礼物：拒绝赠送", () => {
    giftStock(REST_SCROLL_KEY, 1);
    const r = giftItem(db, userId, REST_SCROLL_KEY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("不是礼物");
  });

  it("未知商品拒绝", () => {
    expect(giftItem(db, userId, "phoenix_feather").ok).toBe(false);
  });

  it("存档缺失拒绝", () => {
    db.delete(masterHistory).run();
    db.delete(saves).run();
    const r = giftItem(db, userId, "gift_tea");
    expect(r.ok).toBe(false);
  });
});

describe("商店升级：货架随等级/评级解锁（V3）", () => {
  it("itemUnlockState：无要求直接开放；等级/评级不足给提示", () => {
    const tea = findShopItem("gift_tea")!;
    expect(itemUnlockState(1, "F", tea)).toEqual({ unlocked: true, hint: null });

    const sweet = findShopItem("gift_sweet")!; // min_level 6
    expect(itemUnlockState(5, "E", sweet)).toEqual({
      unlocked: false,
      hint: "需要 Lv.6",
    });
    expect(itemUnlockState(6, "E", sweet).unlocked).toBe(true);

    const star = findShopItem("gift_star_chart")!; // min_rank C
    const locked = itemUnlockState(12, "D", star);
    expect(locked.unlocked).toBe(false);
    expect(locked.hint).toContain("评级 C");
    expect(itemUnlockState(15, "C", star).unlocked).toBe(true);
  });

  it("购买未上架的货：拒绝且不扣钱、不落袋", () => {
    db.update(character).set({ gold: 2000, totalXp: 0 }).where(eq(character.userId, userId)).run();
    const r = purchaseItem(db, userId, "gift_sweet"); // Lv.6 解锁
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("还没上架");
    expect(db.select().from(items).all()).toHaveLength(0);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(2000);
  });

  it("赠送未上架的货：同样拒绝", () => {
    db.update(character).set({ totalXp: 0 }).where(eq(character.userId, userId)).run();
    db.insert(items).values({ id: "it_sweet", userId, itemKey: "gift_sweet", count: 1 }).run();
    const r = giftItem(db, userId, "gift_sweet");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("还没上架");
    expect(db.select().from(items).where(eq(items.userId, userId)).get()!.count).toBe(1);
  });

  it("评级解锁：Lv.15（C）后星图可买", () => {
    // Lv.15 需要累计 1200+...+1550 = ？直接用 rankFromLevel 校验的等级：15
    let xp = 0;
    for (let lv = 1; lv < 15; lv++) xp += 150 + 100 * (lv - 1);
    db.update(character).set({ totalXp: xp, gold: 5000 }).where(eq(character.userId, userId)).run();
    const r = purchaseItem(db, userId, "gift_star_chart");
    expect(r.ok).toBe(true);
  });
});
