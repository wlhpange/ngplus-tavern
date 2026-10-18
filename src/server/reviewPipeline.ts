import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { character, chatLog, disputes, quests, settlementLog, titles } from "./db/schema";
import { getTodaySettledXp } from "./character";
import { startOfToday } from "./util/time";
import {
  applyReviewAdjustments,
  type ReviewVerdict,
} from "./engine/review";
import { levelFromXp } from "./engine/leveling";
import { applyRankPromotion } from "./rankPromotion";
import type { AttrKey } from "./engine/config";
import type { SettlementReviewer, ReviewContext } from "./llm/reviewer";

/**
 * 复核管线（V1.5）：把判定器结论经引擎护栏套用后落账。
 * 结算复核（settle_completion 之后自动触发）与异议复核（file_dispute 触发，
 * 注入用户主张并回写 disputes）共用本管线——双入口收束同一条逻辑。
 *
 * 对账不变式：复核追加/重分类写一条 kind="review_adjustment" 的 settlement_log
 * （追加时 xpAwarded=增量；重分类净额 0）；面板金币/XP 仍等于 settlement_log 累计。
 *
 * DESIGN-DECISION: 评级晋升检查在复核落账后重跑一次（promotedRank 只升不降），
 * 防止复核追加 XP 跨过评级阈值后奖励永久丢失（下次结算的 beforeLevels 已包含该 XP）。
 */

export interface ReviewRunOptions {
  reviewer: SettlementReviewer;
  /** 异议通道：disputes 行 id（file_dispute 工具创建） */
  disputeId?: string;
}

export interface ReviewRunOutcome {
  /** 判定器是否产出了判定（false = fail-open / 未运行） */
  ran: boolean;
  /** 护栏是否应用了调整 */
  applied: boolean;
  /** 前端提示条文案（空串 = 无需展示） */
  notice: string;
  /** 给会长的叙事指令（注入 system，使最终叙事自然融合复核结果） */
  systemMessage: string | null;
}

function noRun(): ReviewRunOutcome {
  return { ran: false, applied: false, notice: "", systemMessage: null };
}

function insertReviewLog(db: Db, userId: string, content: string) {
  db.insert(chatLog)
  .values({ id: randomUUID(), userId, role: "system", content, createdAt: Date.now() })
  .run();
}

/**
 * 对一笔已落账的 quest_complete 结算跑收获复核并落账。
 * settlementId 指向被复核的 quest_complete 行。
 */
export async function runSettlementReview(
  db: Db,
  userId: string,
  settlementId: string,
  opts: ReviewRunOptions,
): Promise<ReviewRunOutcome> {
  const settlement = db
  .select()
  .from(settlementLog)
  .where(eq(settlementLog.id, settlementId))
  .get();
  if (!settlement || settlement.kind !== "quest_complete" || !settlement.questId) {
  return noRun();
  }
  const quest = db
  .select()
  .from(quests)
  .where(eq(quests.id, settlement.questId))
  .get();
  if (!quest) return noRun();

  // 当日已入账 XP（软上限增量口径统一由 getTodaySettledXp 定义；
  // 补审旧结算时按"今天"的口径从紧处理）
  const todaySettledXp = getTodaySettledXp(db, userId);

  const ctx: ReviewContext = {
  questTitle: quest.title,
  questType: quest.type,
  category: quest.category ?? null,
  attrReason: quest.attrReason ?? null,
  primaryAttr: quest.primaryAttr,
  primaryWeight: quest.primaryWeight,
  secondaryAttr: quest.secondaryAttr ?? null,
  secondaryWeight: quest.secondaryWeight ?? null,
  difficulty: quest.difficulty,
  evidence: settlement.llmReasoning ?? null,
  awardedXp: settlement.xpAwarded,
  attrSplit: JSON.parse(settlement.attrSplitJson) as Record<string, number>,
  };

  const verdict = await opts.reviewer.review(ctx).catch(() => null);
  if (!verdict) {
  // fail-open：判定器失败 → 维持原判。结算复核静默跳过；
  // 异议复核必须给用户一个交代——当场按维持原判裁决，不让 disputes 悬在 open。
  if (opts.disputeId) {
  db.update(disputes)
  .set({
  status: "rejected",
  resolution: "复核服务暂时不可用，本次维持原判",
  resolvedAt: Date.now(),
  })
  .where(eq(disputes.id, opts.disputeId))
  .run();
  insertReviewLog(db, userId, "[复核] 异议复核判定器不可用 → 维持原判");
  return {
  ran: false,
  applied: false,
  notice: "",
  systemMessage:
  "【系统复核】用户的异议这次没能完成复核（复核服务暂不可用），已按维持原判处理。用一句人话告诉用户先这样，别报数值。",
  };
  }
  return noRun();
  }

  const application = applyReviewAdjustments(
  {
  awardedXp: settlement.xpAwarded,
  attrSplit: ctx.attrSplit,
  primaryAttr: quest.primaryAttr as AttrKey,
  secondaryAttr: (quest.secondaryAttr ?? null) as AttrKey | null,
  category: quest.category ?? null,
  todaySettledXp,
  },
  verdict,
  );

  const characterRow = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (!characterRow) return noRun();

  let goldFromPromotion = 0;
  let promotionNote = "";

  if (application.applied) {
  // 评级晋升检查（复核前等级 → 复核后等级；只升不降，共用 applyRankPromotion）
  const afterTotalXp = characterRow.totalXp + application.xpDelta;
  const promotion = applyRankPromotion(
  db,
  userId,
  characterRow.totalXp,
  afterTotalXp,
  quest.id,
  "收获复核追加 XP 触发评级晋升",
  );
  if (promotion.gold > 0) {
  goldFromPromotion = promotion.gold;
  promotionNote = promotion.note;
  }

  // 角色面板更新（XP 增量 + 属性增量 + 可能的晋升酬金）
  const updates: Record<string, number> = {
  totalXp: afterTotalXp,
  gold: characterRow.gold + goldFromPromotion,
  };
  const current = characterRow as unknown as Record<string, number>;
  for (const [attr, delta] of Object.entries(application.attrDeltas)) {
  updates[`${attr}Xp`] = (current[`${attr}Xp`] ?? 0) + delta;
  }
  db.update(character)
  .set(updates as Partial<typeof character.$inferInsert>)
  .where(eq(character.userId, userId))
  .run();

  // 复核留痕（adjustments_json 正式启用：完整判定 + 护栏应用明细）
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId: quest.id,
  kind: "review_adjustment",
  completionRatio: null,
  confidence: verdict.confidence,
  xpAwarded: application.xpDelta,
  goldAwarded: 0,
  attrSplitJson: JSON.stringify(application.attrDeltas),
  adjustmentsJson: JSON.stringify({
  settlement_id: settlementId,
  verdict,
  applied: {
  xp_delta: application.xpDelta,
  attr_deltas: application.attrDeltas,
  reclassified: application.reclassified,
  dropped: application.dropped,
  },
  reason: application.reason,
  }),
  llmReasoning: verdict.narrative_hint || null,
  createdAt: Date.now(),
  })
  .run();
  }

  // 异议回写：当场裁决（applied → upheld，否则 rejected）
  if (opts.disputeId) {
  db.update(disputes)
  .set({
  status: application.applied ? "upheld" : "rejected",
  resolution: application.applied
  ? `${application.reason}${promotionNote}`
  : application.reason,
  resolvedAt: Date.now(),
  })
  .where(eq(disputes.id, opts.disputeId))
  .run();
  }

  // 对话留痕（与 [工具] 摘要同级，chat_log system 记录）
  const label = opts.disputeId ? "异议复核" : "收获复核";
  insertReviewLog(
  db,
  userId,
  `[复核] ${label}「${quest.title}」→ ${application.applied ? "采纳" : "维持原判"}：${application.reason}`,
  );

  const notice = application.applied
  ? `${label}「${quest.title}」：${application.reason}${promotionNote}`
  : "";
  const systemMessage = opts.disputeId
  ? application.applied
  ? `【系统复核】用户对「${quest.title}」结算的异议经复核成立：${application.reason}。用一句人话承认判错了、已经修正，不要报任何数值。`
  : `【系统复核】用户对「${quest.title}」结算的异议经复核维持原判：${application.reason}。用一句人话答复，不报数值、不和用户争辩。`
  : application.applied
  ? `【系统复核】「${quest.title}」的结算经收获复核调整：${application.reason}。你可以在叙事里自然承认这份计划外的收获，但不要报任何数值。`
  : null;

  return { ran: true, applied: application.applied, notice, systemMessage };
}

export type { ReviewVerdict, ReviewContext };
