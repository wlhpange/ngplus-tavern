import { config, ATTR_KEYS, type AttrKey } from "./config";
import { applyDailySoftCap } from "./settlement";

/**
 * 收获复核引擎（V1.5，两阶段判定的第二阶段）。
 *
 * 判定器（LLM，llm/reviewer.ts）并排注入「预设映射 vs 实际汇报」回答三问：
 * 1. 现实 vs 计划是同一件事吗？ → 重分类（仅校验表内）
 * 2. 投入显著超出计划？  → 超额加成
 * 3. 有计划外的副产品？  → 追加辅属性
 *
 * 本模块是护栏（纯代码，）：判定器输出只有经过这里才生效。
 * - 属性调整仅允许校验表内属性；willpower 一律剥离（意志经验由代码独占计算）
 * - XP 追加幅度钳制在 0 ~ bonus_cap_ratio（总调整天然 ≤1.5×）
 * - DESIGN-DECISION: 复核只加不减、不动金币——复核不是惩罚工具，
 *  金币公式与连击/超额无关，动它就破坏「面板金币 = settlement_log 累计」对账。
 * - DESIGN-DECISION: 重分类实现为「把原主属性的全部入账份额转移给新属性」。
 *  不重算软上限缩放（需要当日已结算 XP，无法从留痕重建），转移语义对玩家
 *  可解释：这活儿的性质判错了，主属性那份记到正确的属性头上。
 *  原主属性为 willpower 时拒绝重分类（防止转移代码独占的连击经验）。
 * - 旧行（无 category）按 primary_attr 反查白名单第一个包含它的类别。
 */

export interface BonusAllocation {
  attr: AttrKey;
  /** 0~1，追加 XP 在有效分配项间按权重归一化 */
  share: number;
  reason: string;
}

/** 判定器（LLM）的结构化输出（llm/reviewer.ts 的 zod schema 与此对应） */
export interface ReviewVerdict {
  no_adjustment: boolean;
  /** 0~1，相对已入账 XP 的追加比例；引擎钳制 ≤ review.bonus_cap_ratio */
  xp_bonus_ratio: number;
  bonus_allocations: BonusAllocation[];
  reclassification: { attr: AttrKey; reason: string } | null;
  /** ≤30 字，供会长叙事与提示条使用 */
  narrative_hint: string;
  confidence: number;
}

export interface ReviewInput {
  /** 原结算入账 XP（settlement_log.xp_awarded） */
  awardedXp: number;
  /** 原属性分流（settlement_log.attr_split_json，含 willpower 连击部分） */
  attrSplit: Record<string, number>;
  primaryAttr: AttrKey;
  secondaryAttr: AttrKey | null;
  /** 任务类别；V1 老数据可能为 NULL → 引擎按 primary_attr 反查 */
  category: string | null;
  /**
  * 当日已入账 XP（含本次原结算）。提供时追加部分同样受每日软上限约束
  * ：超出 120 的部分 ×0.3。异议通道补审旧结算时传当日值。
  */
  todaySettledXp?: number;
}

export interface ReviewApplication {
  applied: boolean;
  /** 总账 XP 增量（重分类净额为 0，不进此字段） */
  xpDelta: number;
  /** 属性增量（Σ === xpDelta；重分类项正负相抵） */
  attrDeltas: Partial<Record<AttrKey, number>>;
  /** 重分类明细（审计展示用） */
  reclassified: { from: AttrKey; to: AttrKey; xp: number } | null;
  /** 被护栏丢弃的判定项（写进 adjustments_json 留痕） */
  dropped: string[];
  /** 不应用时的原因 / 应用时的摘要 */
  reason: string;
}

/** 判定器的输出是否需要进入引擎（置信度门槛在引擎侧统一执行） */
export function isVerdictActionable(verdict: ReviewVerdict): boolean {
  if (!config.review.enabled) return false;
  if (verdict.no_adjustment) return false;
  if (verdict.confidence < config.review.min_confidence) return false;
  return true;
}

/** 类别 → 允许属性；无类别时按主属性反查白名单，仍无结果则回退全部属性（willpower 另行剥离） */
function allowedAttrsFor(category: string | null, primaryAttr: AttrKey): {
  allowed: AttrKey[];
  inferred: boolean;
} {
  const whitelist = config.attr_whitelist as Record<string, AttrKey[]>;
  if (category && whitelist[category]) {
  return { allowed: whitelist[category], inferred: false };
  }
  for (const [cat, attrs] of Object.entries(whitelist)) {
  if (attrs.includes(primaryAttr)) {
  return { allowed: attrs, inferred: true };
  }
  }
  return { allowed: [...ATTR_KEYS], inferred: true };
}

function notApplied(reason: string, dropped: string[] = []): ReviewApplication {
  return { applied: false, xpDelta: 0, attrDeltas: {}, reclassified: null, dropped, reason };
}

/**
 * 把判定器的结论套上护栏，产出可执行的调整明细。
 * 纯函数：不读库、不写库，调用方（llm 层钩子）负责落账。
 */
export function applyReviewAdjustments(
  input: ReviewInput,
  verdict: ReviewVerdict,
): ReviewApplication {
  if (!config.review.enabled) {
  return notApplied("收获复核未启用");
  }
  if (verdict.no_adjustment) {
  return notApplied(verdict.narrative_hint || "复核无调整");
  }
  if (verdict.confidence < config.review.min_confidence) {
  return notApplied(
  `复核置信度不足（${verdict.confidence} < ${config.review.min_confidence}）`,
  );
  }
  if (input.awardedXp <= 0) {
  return notApplied("原结算无可调整的入账 XP");
  }

  const { allowed, inferred } = allowedAttrsFor(input.category, input.primaryAttr);
  const categoryLabel = input.category ?? `（按主属性反查${inferred ? "：" + allowed.join("/") : "失败"}）`;
  const dropped: string[] = [];

  // ---- 追加 XP（护栏：钳制上限；软上限；willpower/越界属性剥离，全部无效时兜底主属性）----
  const bonusRatio = Math.max(
  0,
  Math.min(verdict.xp_bonus_ratio, config.review.bonus_cap_ratio),
  );
  let bonusXp = Math.round(input.awardedXp * bonusRatio);
  if (bonusXp > 0 && input.todaySettledXp != null) {
  bonusXp = Math.round(applyDailySoftCap(bonusXp, input.todaySettledXp + input.awardedXp));
  }

  const validAllocations = verdict.bonus_allocations.filter((a) => {
  if (a.attr === "willpower") {
  dropped.push(`追加分配 willpower 被剥离（意志经验由代码独占）`);
  return false;
  }
  if (!allowed.includes(a.attr)) {
  dropped.push(`追加分配 ${a.attr} 越界（类别 ${categoryLabel} 只允许 ${allowed.join("/")}）`);
  return false;
  }
  return true;
  });

  const attrDeltas: Partial<Record<AttrKey, number>> = {};
  let bonusTargets: AttrKey[];
  if (bonusXp > 0 && validAllocations.length === 0) {
  // 无有效分配项（未给或全部越界）：兜底记到任务主属性，计划外战果不因映射错误丢失
  bonusTargets = [input.primaryAttr];
  dropped.push(
  verdict.bonus_allocations.length > 0
  ? `追加分配全部越界，兜底记入主属性 ${input.primaryAttr}`
  : `判定器未给追加分配，兜底记入主属性 ${input.primaryAttr}`,
  );
  } else {
  // 去重：判定器可能对同一属性给多条分配，find 只取每属性第一条
  bonusTargets = [...new Set(validAllocations.map((a) => a.attr))];
  }

  if (bonusXp > 0 && bonusTargets.length > 0) {
  const shareSum = validAllocations.length
  ? validAllocations.reduce((s, a) => s + Math.max(0, a.share), 0)
  : 0;
  if (bonusTargets.length === 1 || shareSum <= 0) {
  attrDeltas[bonusTargets[0]] = (attrDeltas[bonusTargets[0]] ?? 0) + bonusXp;
  } else {
  let assigned = 0;
  for (const target of bonusTargets) {
  const alloc = validAllocations.find((a) => a.attr === target)!;
  const share = Math.max(0, alloc.share) / shareSum;
  const amount = Math.round(bonusXp * share);
  attrDeltas[target] = (attrDeltas[target] ?? 0) + amount;
  assigned += amount;
  }
  // 取整误差并入第一个目标，保证 Σ === bonusXp
  attrDeltas[bonusTargets[0]] = (attrDeltas[bonusTargets[0]] ?? 0) + (bonusXp - assigned);
  }
  }

  // ---- 重分类（转移原主属性份额；willpower 主属性拒绝转移）----
  let reclassified: ReviewApplication["reclassified"] = null;
  const reclass = verdict.reclassification;
  if (reclass && reclass.attr !== input.primaryAttr) {
  if (input.primaryAttr === "willpower") {
  dropped.push("重分类被拒绝：原主属性 willpower 的经验由代码独占");
  } else if (reclass.attr === "willpower") {
  dropped.push("重分类目标 willpower 被拒绝（意志经验由代码独占）");
  } else if (!allowed.includes(reclass.attr)) {
  dropped.push(`重分类目标 ${reclass.attr} 越界（类别 ${categoryLabel} 只允许 ${allowed.join("/")}）`);
  } else {
  const moved = input.attrSplit[input.primaryAttr] ?? 0;
  if (moved > 0) {
  reclassified = { from: input.primaryAttr, to: reclass.attr, xp: moved };
  attrDeltas[input.primaryAttr] = (attrDeltas[input.primaryAttr] ?? 0) - moved;
  attrDeltas[reclass.attr] = (attrDeltas[reclass.attr] ?? 0) + moved;
  } else {
  dropped.push("重分类放弃：原主属性无入账份额");
  }
  }
  }

  const xpDelta = bonusXp;
  const totalDelta = Object.values(attrDeltas).reduce((a, b) => a + b, 0);
  if (totalDelta !== xpDelta) {
  // 理论不可达（重分类净额为 0，取整误差已并入首个目标）；防御性断言
  throw new Error(`复核调整取整不闭合：attrDeltas 合计 ${totalDelta} ≠ xpDelta ${xpDelta}`);
  }

  if (xpDelta === 0 && !reclassified) {
  return notApplied("复核未产生有效调整", dropped);
  }

  return {
  applied: true,
  xpDelta,
  attrDeltas,
  reclassified,
  dropped,
  reason: verdict.narrative_hint || "收获复核调整",
  };
}
