import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { character } from "@/server/db/schema";
import { levelFromXp, rankFromLevel } from "@/server/engine/leveling";
import {
  getItemStock,
  giftItem,
  itemUnlockState,
  purchaseItem,
  shopCatalog,
} from "@/server/shop";
import { shopDiscountFor } from "@/server/dailyEvent";
import { getSaveState } from "@/server/masters";

export const dynamic = "force-dynamic";

/**
 * 协会商店（V1.5，V2.0 增加赠送，V3 货架随等级/评级逐级解锁）。
 * GET：目录 + 持有数量 + 金币 + 亲密度阶段 + 每件货的解锁状态。
 * POST：{ itemKey, action }，action 缺省 "buy"；"gift" 消耗一份并推进亲密度。
 * 交易是确定性动作，直连 API 不经 LLM（对话内的 buy_item / gift_item 工具走同一服务函数）。
 */
export async function GET() {
  const { db, userId } = bootstrap();
  const char = db
    .select({ gold: character.gold, totalXp: character.totalXp })
    .from(character)
    .where(eq(character.userId, userId))
    .get();
  const save = getSaveState(db, userId);
  const level = levelFromXp(char?.totalXp ?? 0);
  const rank = rankFromLevel(level);
  return NextResponse.json({
    gold: char?.gold ?? 0,
    level,
    rank,
    intimacy: save
      ? { stage: save.intimacyStage, label: save.intimacyLabel, points: save.intimacyPoints }
      : null,
    items: shopCatalog().map((item) => {
      const shelf = itemUnlockState(level, rank, item);
      const discount = shopDiscountFor(db, userId, item);
      return {
        ...item,
        count: getItemStock(db, userId, item.key)?.count ?? 0,
        unlocked: shelf.unlocked,
        unlockHint: shelf.hint,
        discount: discount
          ? { ratio: discount.ratio, priceAfter: discount.priceAfter }
          : null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    itemKey?: string;
    action?: string;
  } | null;
  if (!body?.itemKey) {
    return NextResponse.json({ error: "缺少 itemKey" }, { status: 400 });
  }
  const { db, userId } = bootstrap();
  const action = body.action ?? "buy";

  if (action === "gift") {
    const result = giftItem(db, userId, body.itemKey);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, receipt: result.receipt });
  }

  const result = purchaseItem(db, userId, body.itemKey);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, receipt: result.receipt });
}
