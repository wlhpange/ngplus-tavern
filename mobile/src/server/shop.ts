import { and, eq } from "drizzle-orm";
import { randomUUID } from "./util/id";
import type { Db } from "./db";
import { character, items, memory, saves, settlementLog } from "./db/schema";
import { config } from "./engine/config";
import { levelFromXp, rankFromLevel, rankIndex } from "./engine/leveling";
import { addAffinityPoints, intimacyLabel } from "./masters";
import { shopDiscountFor } from "./dailyEvent";

/**
 * 协会商店（V1.5 金币消耗口，V2.0 接入礼物赠送与亲密度）。
 *
 * 铁律：金币只有仪式感消耗口，无数值消耗口——买不到 XP、买不到判定通融。
 * 商品目录全部在 economy_config.json() 的 shop.items（配置驱动，改数值不动代码）。
 *
 * 对账不变式：购买写 settlement_log（kind="purchase"，gold_awarded=−价格），
 * 面板金币恒等于 settlement_log 的 gold_awarded 累计。赠送不动金币，
 * 只写 kind="gift"（gold_awarded=0）留痕 + 推进亲密度。
 *
 * DESIGN-DECISION(V2.0): 购买 = 放进抽屉；赠送 = 消耗一份并推进亲密度。
 * 旧版「买礼物即视为送出」的行为随之作废（礼物不再在购买时落 memory）。
 * DESIGN-DECISION(V1.7.1): 皮肤系统整体下线（列/商品/装备逻辑均已移除），窗口装扮类目不复存在。
 */

export type ShopItemType = "consumable" | "gift";

/** 货架解锁条件（商店升级：随等级/评级逐级开放） */
export interface ShopItemUnlock {
  min_level?: number;
  min_rank?: string;
}

export interface ShopItem {
  key: string;
  name: string;
  type: ShopItemType;
  price: number;
  desc: string;
  unlock?: ShopItemUnlock;
}

export const REST_SCROLL_KEY = "rest_scroll";

export function shopCatalog(): ShopItem[] {
  return config.shop.items as ShopItem[];
}

export function findShopItem(itemKey: string): ShopItem | null {
  return shopCatalog().find((i) => i.key === itemKey) ?? null;
}

export interface UnlockState {
  unlocked: boolean;
  /** 未解锁时的货架提示（如「需要 Lv.6」/「需要 评级 C（突破解锁）」） */
  hint: string | null;
}

/** 货架解锁判定（纯函数）：等级与评级都要满足 */
export function itemUnlockState(
  totalLevel: number,
  rank: string,
  item: ShopItem,
): UnlockState {
  const req = item.unlock;
  if (!req) return { unlocked: true, hint: null };
  const levelOk = req.min_level == null || totalLevel >= req.min_level;
  const rankOk = req.min_rank == null || rankIndex(rank) >= rankIndex(req.min_rank);
  if (levelOk && rankOk) return { unlocked: true, hint: null };
  const parts: string[] = [];
  if (req.min_level != null && !levelOk) parts.push(`Lv.${req.min_level}`);
  if (req.min_rank != null && !rankOk) parts.push(`评级 ${req.min_rank}（突破解锁）`);
  return { unlocked: false, hint: `需要 ${parts.join(" · ")}` };
}

/** 当前角色视角下的货架状态（给 API/UI 用） */
export function shopShelfState(
  totalLevel: number,
  rank: string,
): { item: ShopItem; unlocked: boolean; hint: string | null }[] {
  return shopCatalog().map((item) => ({
    item,
    ...itemUnlockState(totalLevel, rank, item),
  }));
}

export interface ItemStock {
  itemKey: string;
  count: number;
}

/** 用户持有的道具 */
export function getItemStock(db: Db, userId: string, itemKey: string): ItemStock | null {
  const row = db
  .select()
  .from(items)
  .where(and(eq(items.userId, userId), eq(items.itemKey, itemKey)))
  .get();
  return row ? { itemKey: row.itemKey, count: row.count } : null;
}

export interface PurchaseReceipt {
  itemKey: string;
  name: string;
  type: ShopItemType;
  price: number;
  /** 旅商折扣时：原价与折扣比例 */
  originalPrice?: number;
  discountRatio?: number;
  goldLeft: number;
  count: number;
}

export type PurchaseResult =
  | { ok: true; receipt: PurchaseReceipt }
  | { ok: false; error: string };

/** 购买商品：校验 → 扣金币 → 道具入袋 → 购买留痕（礼物额外落 memory） */
export function purchaseItem(
  db: Db,
  userId: string,
  itemKey: string,
  now = Date.now(),
): PurchaseResult {
  const item = findShopItem(itemKey);
  if (!item) {
  return { ok: false, error: `商店里没有「${itemKey}」这件东西` };
  }
  const char = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (!char) {
  return { ok: false, error: "角色数据缺失，请先完成初始化" };
  }
  // 商店升级（V3）：货架随等级/评级逐级解锁
  const level = levelFromXp(char.totalXp);
  const shelf = itemUnlockState(level, rankFromLevel(level), item);
  if (!shelf.unlocked) {
  return { ok: false, error: `「${item.name}」还没上架：${shelf.hint}。` };
  }
  // V3 每日事件：旅商过境（当天某件礼物打折）
  const discount = shopDiscountFor(db, userId, item);
  const price = discount?.priceAfter ?? item.price;
  if (char.gold < price) {
  return {
  ok: false,
  error: `金币不够。${item.name}要 ${price} 金币，你还差 ${price - char.gold}。`,
  };
  }

  const existing = getItemStock(db, userId, itemKey);

  // 扣金币（对账不变式：金币 = settlement_log 的 gold_awarded 累计）
  const goldLeft = char.gold - price;
  db.update(character).set({ gold: goldLeft }).where(eq(character.userId, userId)).run();

  // 入袋
  if (existing) {
  db
  .update(items)
  .set({ count: existing.count + 1 })
  .where(and(eq(items.userId, userId), eq(items.itemKey, item.key)))
  .run();
  } else {
  db
  .insert(items)
  .values({ id: randomUUID(), userId, itemKey: item.key, count: 1 })
  .run();
  }

  // 购买留痕（ 所有结算留痕；负金币保持对账闭合）
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId: null,
  kind: "purchase",
  completionRatio: null,
  confidence: null,
  xpAwarded: 0,
  goldAwarded: -price,
  attrSplitJson: "{}",
  adjustmentsJson: JSON.stringify({
  item_key: item.key,
  type: item.type,
  ...(discount ? { discount_ratio: discount.ratio } : {}),
  }),
  llmReasoning: null,
  createdAt: now,
  })
  .run();

  // V2.0：购买只放进抽屉，不再落「送给会长」记忆——
  // 赠送是明确动作，走 giftItem（消耗 + 亲密度 + 留痕 + 记忆）。
  const count = (existing?.count ?? 0) + 1;
  return {
  ok: true,
  receipt: {
  itemKey: item.key,
  name: item.name,
  type: item.type,
  price,
  ...(discount
  ? { originalPrice: item.price, discountRatio: discount.ratio }
  : {}),
  goldLeft,
  count,
  },
  };
}

// V1.7.1 皮肤系统收敛：窗口装扮类目与装备动作已随「星穹秘契」单一视觉定稿移除。

// ---------------------------------------------------------------------------
// V2.0 礼物赠送 + 亲密度推进
// ---------------------------------------------------------------------------

export interface GiftReceipt {
  itemKey: string;
  name: string;
  /** 本次赠送获得的亲密度经验 */
  points: number;
  /** 赠送后的累计亲密度经验 */
  pointsTotal: number;
  intimacyStage: number;
  intimacyLabel: string;
  /** 本次是否跨过阶段阈值 */
  stageUp: boolean;
  /** 抽屉里剩余的份数 */
  countLeft: number;
}

export type GiftResult =
  | { ok: true; receipt: GiftReceipt }
  | { ok: false; error: string };

/**
 * 赠送礼物：消耗一份持有 → 亲密度经验 + → 可能阶段提升 → 留痕 + 记忆。
 * 不动金币（对账不变式不受影响）。
 */
export function giftItem(
  db: Db,
  userId: string,
  itemKey: string,
  now = Date.now(),
): GiftResult {
  const item = findShopItem(itemKey);
  if (!item) return { ok: false, error: `商店里没有「${itemKey}」这件东西` };
  if (item.type !== "gift") {
    return { ok: false, error: `「${item.name}」不是礼物，不能赠送` };
  }
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) return { ok: false, error: "存档数据缺失，请先完成初始化" };
  if (!save.activeMasterId) return { ok: false, error: "还没有会长，先去选一位" };
  // 商店升级（V3）：礼物的货架解锁与购买同一把尺
  const char = db.select().from(character).where(eq(character.userId, userId)).get();
  if (!char) return { ok: false, error: "角色数据缺失，请先完成初始化" };
  const level = levelFromXp(char.totalXp);
  const shelf = itemUnlockState(level, rankFromLevel(level), item);
  if (!shelf.unlocked) {
    return { ok: false, error: `「${item.name}」还没上架：${shelf.hint}。` };
  }
  const stock = getItemStock(db, userId, itemKey);
  if (!stock || stock.count < 1) {
    return {
      ok: false,
      error: `抽屉里没有「${item.name}」了，先在商店买一份再送。`,
    };
  }

  // 消耗一份
  db.update(items)
  .set({ count: stock.count - 1 })
  .where(and(eq(items.userId, userId), eq(items.itemKey, itemKey)))
  .run();

  // 亲密度推进（阈值见 economy_config.intimacy）：P11 按当前会长各记一份
  const pointsMap = config.intimacy.gift_points as Record<string, number>;
  const points = pointsMap[itemKey] ?? 1;
  const affinity = addAffinityPoints(db, userId, save.activeMasterId, points);
  const pointsTotal = affinity.points;
  const stageAfter = affinity.toStage;
  const stageUp = affinity.stageChanged;

  // 留痕（不动金币，gold_awarded=0；面板历史可显示「礼物赠送」）
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId: null,
  kind: "gift",
  completionRatio: null,
  confidence: null,
  xpAwarded: 0,
  goldAwarded: 0,
  attrSplitJson: "{}",
  adjustmentsJson: JSON.stringify({
  item_key: itemKey,
  intimacy_points: points,
  intimacy_total: pointsTotal,
  stage_up: stageUp,
  }),
  llmReasoning: null,
  createdAt: now,
  })
  .run();

  // 记忆：会长在后续对话里自然记得收到过什么；阶段跨过时单独记一笔
  const label = intimacyLabel(stageAfter);
  db.insert(memory)
  .values({
  id: randomUUID(),
  userId,
  category: "event",
  content: stageUp
  ? `收到「${item.name}」，你们的关系更进一步了（交情：${label}）`
  : `收到「${item.name}」`,
  createdAt: now,
  })
  .run();

  return {
  ok: true,
  receipt: {
  itemKey,
  name: item.name,
  points,
  pointsTotal,
  intimacyStage: stageAfter,
  intimacyLabel: label,
  stageUp,
  countLeft: stock.count - 1,
  },
  };
}
