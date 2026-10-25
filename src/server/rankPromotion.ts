
import { randomUUID } from "./util/id";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { items, memory, settlementLog, titles } from "./db/schema";
import { levelFromXp, promotedRank, rankFromLevel, rankUpGoldReward } from "./engine/leveling";
import { config } from "./engine/config";
import { REST_SCROLL_KEY, shopCatalog } from "./shop";

/**
 * 评级突破（只升不降，economy-design §8）：
 * 校验/复核/签到等任何"事后追加 XP"的路径都必须走这里，
 * 防止追加 XP 跨过评级阈值后奖励永久丢失（下次结算的 beforeLevels 已含该 XP）。
 * 抽取自 V1.5 execSettleCompletion 的内联逻辑，供复核管线与签到结算共用。
 *
 * 突破礼（2026-09-27）：金币一次性酬金 + 休整卷轴（economy_config.rank_reward），
 * 同时写一条 event 记忆，会长后续可以自然地提到这次突破。
 */

export interface RankPromotionResult {
  gold: number;
  note: string;
  /** 未晋升时为 null */
  from: string | null;
  to: string | null;
  /** 突破礼物品（已入袋） */
  items: { key: string; name: string; count: number }[];
}

export function applyRankPromotion(
  db: Db,
  userId: string,
  beforeTotalXp: number,
  afterTotalXp: number,
  questId: string | null,
  reason: string,
): RankPromotionResult {
  const beforeRank = rankFromLevel(levelFromXp(beforeTotalXp));
  const promotion = promotedRank(beforeRank, levelFromXp(afterTotalXp));
  if (!promotion.promoted) {
    return { gold: 0, note: "", from: null, to: null, items: [] };
  }
  const gold = rankUpGoldReward(promotion.rank);

  db.insert(titles)
  .values({
  id: randomUUID(),
  userId,
  titleKey: `rank_${promotion.rank}`,
  grantedAt: Date.now(),
  })
  .run();
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId,
  kind: "title_grant",
  completionRatio: null,
  confidence: null,
  xpAwarded: 0,
  goldAwarded: gold,
  attrSplitJson: "{}",
  adjustmentsJson: JSON.stringify({
    breakthrough: { from: beforeRank, to: promotion.rank },
  }),
  llmReasoning: `${reason}（评级突破 ${beforeRank} → ${promotion.rank}）`,
  createdAt: Date.now(),
  })
  .run();

  // 突破礼：休整卷轴（配置驱动，0 表示不发）
  const granted: RankPromotionResult["items"] = [];
  const scrollCount = config.rank_reward.rest_scroll ?? 0;
  if (scrollCount > 0) {
    const existing = db
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, REST_SCROLL_KEY)))
      .get();
    if (existing) {
      db.update(items)
        .set({ count: existing.count + scrollCount })
        .where(eq(items.id, existing.id))
        .run();
    } else {
      db.insert(items)
        .values({
          id: randomUUID(),
          userId,
          itemKey: REST_SCROLL_KEY,
          count: scrollCount,
        })
        .run();
    }
    granted.push({
      key: REST_SCROLL_KEY,
      name: shopCatalog().find((i) => i.key === REST_SCROLL_KEY)?.name ?? REST_SCROLL_KEY,
      count: scrollCount,
    });
  }

  db.insert(memory)
  .values({
  id: randomUUID(),
  userId,
  category: "event",
  content: `达成突破：评级 ${beforeRank} → ${promotion.rank}`,
  createdAt: Date.now(),
  })
  .run();

  return {
  gold,
  note: `；评级突破 ${beforeRank} → ${promotion.rank}`,
  from: beforeRank,
  to: promotion.rank,
  items: granted,
  };
}
