import { and, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { dailyEvents, settlementLog } from "./db/schema";
import { config } from "./engine/config";
import { startOfToday } from "./util/time";

/**
 * 每日随机事件（V3）：小概率触发一个当天的世界事件，效果全部配置化。
 * - 每天至多一条（daily_events 唯一索引兜底），当天重复调用返回同一条，不再掷骰
 * - 效果类型：
 *   shop_discount          —— 当天某件礼物打折（payload.item_key，ratio）
 *   settlement_gold_ratio  —— 当天结算金币加成
 *   first_settlement_xp_ratio —— 当天第一笔结算 XP 加成
 * - LLM 只负责叙事（会长开场提一句），数值全部由引擎在这一层与消费方执行
 */

export interface DailyEventDef {
  key: string;
  name: string;
  desc: string;
  effect:
    | { type: "shop_discount"; ratio: number }
    | { type: "settlement_gold_ratio"; value: number }
    | { type: "first_settlement_xp_ratio"; value: number };
}

export interface DailyEvent {
  key: string;
  name: string;
  desc: string;
  effect: DailyEventDef["effect"];
  payload: Record<string, unknown>;
}

export function dailyEventCatalog(): DailyEventDef[] {
  return (config.daily_event as { events: DailyEventDef[] }).events;
}

function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toDailyEvent(row: {
  eventKey: string;
  payloadJson: string;
}): DailyEvent | null {
  const def = dailyEventCatalog().find((e) => e.key === row.eventKey);
  if (!def) return null;
  return {
    key: def.key,
    name: def.name,
    desc: def.desc,
    effect: def.effect,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
  };
}

/** 读取今天的既有事件（不掷骰） */
export function getTodayEvent(
  db: Db,
  userId: string,
  now: Date = new Date(),
): DailyEvent | null {
  const row = db
    .select()
    .from(dailyEvents)
    .where(and(eq(dailyEvents.userId, userId), eq(dailyEvents.dayKey, localDayKey(now))))
    .get();
  return row ? toDailyEvent(row) : null;
}

/**
 * 掷骰（当天首次对话时调用）：命中概率才产生事件；已存在则原样返回。
 * @param rand 注入随机源（测试用）
 */
export function rollDailyEvent(
  db: Db,
  userId: string,
  now: Date = new Date(),
  rand: () => number = Math.random,
): { event: DailyEvent | null; fresh: boolean } {
  const existing = getTodayEvent(db, userId, now);
  if (existing) return { event: existing, fresh: false };

  const chance = (config.daily_event as { chance: number }).chance;
  if (rand() >= chance) return { event: null, fresh: false };

  const pool = dailyEventCatalog();
  if (pool.length === 0) return { event: null, fresh: false };
  const def = pool[Math.floor(rand() * pool.length) % pool.length];

  // 打折事件随机挑一件礼物（直接读配置，避免与 shop.ts 形成循环依赖）
  const payload: Record<string, unknown> = {};
  if (def.effect.type === "shop_discount") {
    const gifts = (config.shop.items as { key: string; type: string }[]).filter(
      (i) => i.type === "gift",
    );
    const pick = gifts[Math.floor(rand() * gifts.length) % Math.max(1, gifts.length)];
    if (pick) payload.item_key = pick.key;
  }

  db.insert(dailyEvents)
    .values({
      id: randomUUID(),
      userId,
      dayKey: localDayKey(now),
      eventKey: def.key,
      payloadJson: JSON.stringify(payload),
      createdAt: now.getTime(),
    })
    .run();

  return {
    event: { key: def.key, name: def.name, desc: def.desc, effect: def.effect, payload },
    fresh: true,
  };
}

/** 结算金币加成（会长心情） */
export function dailyGoldRatio(
  db: Db,
  userId: string,
  now: Date = new Date(),
): number {
  const event = getTodayEvent(db, userId, now);
  if (event?.effect.type === "settlement_gold_ratio") return event.effect.value;
  return 0;
}

/** 当天第一笔结算的 XP 加成（星夜）：只对今天的第一笔 quest_complete 生效 */
export function dailyFirstSettlementXpRatio(
  db: Db,
  userId: string,
  now: Date = new Date(),
): number {
  const event = getTodayEvent(db, userId, now);
  if (event?.effect.type !== "first_settlement_xp_ratio") return 0;
  const settledToday = db
    .select({ id: settlementLog.id })
    .from(settlementLog)
    .where(
      and(
        eq(settlementLog.userId, userId),
        eq(settlementLog.kind, "quest_complete"),
        gte(settlementLog.createdAt, startOfToday()),
      ),
    )
    .limit(1)
    .all();
  return settledToday.length === 0 ? event.effect.value : 0;
}

/** 叙事化描述（给提示词/提示条用；折扣事件带上商品名） */
export function dailyEventNarrative(ev: DailyEvent): string {
  if (
    ev.effect.type === "shop_discount" &&
    typeof ev.payload.item_key === "string"
  ) {
    const item = (
      config.shop.items as { key: string; name: string }[]
    ).find((i) => i.key === ev.payload.item_key);
    return `${ev.name}：${ev.desc}${item ? `（打折的是「${item.name}」）` : ""}`;
  }
  return `${ev.name}：${ev.desc}`;
}

/** 商品折扣（旅商过境）：返回折扣比例与折后价；未命中返回 null */
export function shopDiscountFor(
  db: Db,
  userId: string,
  item: { key: string; price: number },
  now: Date = new Date(),
): { ratio: number; priceAfter: number } | null {
  const event = getTodayEvent(db, userId, now);
  if (event?.effect.type !== "shop_discount") return null;
  if (event.payload.item_key !== item.key) return null;
  const ratio = event.effect.ratio;
  return {
    ratio,
    priceAfter: Math.max(1, Math.round(item.price * (1 - ratio))),
  };
}
