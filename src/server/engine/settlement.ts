import { config, type AttrKey, type QuestType } from "./config";
import { streakBonusMultiplier } from "./streak";

/**
 * 每日软上限：当日累计前 120 XP 全额，超出部分 ×0.3
 * @param incomingXp 本次结算原始 XP（可为小数）
 * @param todaySettledXp 今日已结算 XP 累计
 */
export function applyDailySoftCap(
  incomingXp: number,
  todaySettledXp: number,
): number {
  const { xp_full_amount, excess_ratio } = config.daily_soft_cap;
  const remaining = Math.max(0, xp_full_amount - todaySettledXp);
  const full = Math.min(incomingXp, remaining);
  const excess = incomingXp - full;
  return full + excess * excess_ratio;
}

export interface SettleInput {
  type: QuestType;
  difficulty: number;
  streak: number;
  /** 完成度：≤1 按比例折算；>1 启用超额系数 */
  completionRatio: number;
  primaryAttr: AttrKey;
  /** 无辅属性时主属性 100%（默认 1.0） */
  primaryWeight?: number;
  secondaryAttr?: AttrKey | null;
  secondaryWeight?: number | null;
  /** 今日已结算 XP（用于软上限增量计算） */
  todaySettledXp: number;
  /** 断签减半等场景下由调用方覆盖连击倍率（默认按 streak 计算） */
  streakMultiplierOverride?: number;
  /** 被动技能：连击上限加成（0.15 → 上限 1.65） */
  streakCapAdd?: number;
  /** 被动技能：超额总乘区上限加成（0.25 → 上限 1.75） */
  overCapAdd?: number;
  /** 每日事件：本次结算的 XP 加成比例（星夜；乘在软上限之前） */
  xpBonusRatio?: number;
}

export interface SettleResult {
  /** 软上限前的原始任务 XP */
  questXpRaw: number;
  /** 软上限后实际入账 XP（整数） */
  xpAwarded: number;
  /** 金币 = 基准金币 × difficulty，不吃连击/超额 */
  goldAwarded: number;
  /** 属性分流（整数，合计 === xpAwarded） */
  attrSplit: Partial<Record<AttrKey, number>>;
  multipliers: { streak: number; over: number; total: number };
}

/**
 * 任务结算（，纯代码实现）：
 * 任务XP = 基准XP × difficulty × 连击加成 × 超额系数（总乘区上限 1.5）
 * 金币  = 基准金币 × difficulty（不吃连击/超额）
 *
 * DESIGN-DECISION:
 * 1. 超额系数取 completion_ratio 本身（>1 时），与连击加成相乘后按“总乘区上限 1.5”封顶。
 * 2. completion_ratio < 1（部分结算）按线性折算，与 §6.2 的置信度追问流程互补。
 * 3. “willpower 的连击部分由代码追加”实现为：连击加成产生的额外 XP
 *  （基准 × difficulty × (连击倍率 − 1)）不参与主/辅属性权重分流，
 *  由代码直接追加到 willpower；主/辅属性只分流扣除该部分后的核心 XP。
 *  LLM 的权重参数因此无权分配意志经验中的连击收益。
 */
export function settleQuest(input: SettleInput): SettleResult {
  const base = config.quest_base[input.type];
  const ratio = input.completionRatio;

  const streakMult =
  input.streakMultiplierOverride ??
  streakBonusMultiplier(input.streak, input.streakCapAdd ?? 0);
  const overMult =
  ratio > config.over_completion.threshold ? ratio : 1;
  const totalMult = Math.min(
  streakMult * overMult,
  config.over_completion.total_multiplier_cap + (input.overCapAdd ?? 0),
  );
  const partialMult = ratio <= 1 ? ratio : 1;

  const rawTotal =
  base.xp *
  input.difficulty *
  totalMult *
  partialMult *
  (1 + (input.xpBonusRatio ?? 0));
  const willpowerBonusRaw =
  base.xp * input.difficulty * (streakMult - 1) * partialMult;
  const coreRaw = Math.max(0, rawTotal - willpowerBonusRaw);

  const goldAwarded = Math.round(base.gold * input.difficulty);

  const xpAfterCap = applyDailySoftCap(rawTotal, input.todaySettledXp);
  const xpAwarded = Math.round(xpAfterCap);
  const scale = rawTotal > 0 ? xpAwarded / rawTotal : 0;

  // 属性分流：主/辅按权重归一化分流核心部分；连击加成部分追加 willpower
  const primaryWeight = input.primaryWeight ?? 1.0;
  const hasSecondary =
  input.secondaryAttr != null && (input.secondaryWeight ?? 0) > 0;
  const secondaryWeight = hasSecondary ? (input.secondaryWeight as number) : 0;
  const weightSum = hasSecondary ? primaryWeight + secondaryWeight : 1;

  const coreScaled = coreRaw * scale;
  const willScaled = willpowerBonusRaw * scale;

  const split: Partial<Record<AttrKey, number>> = {};
  const primaryCoreShare = hasSecondary
  ? (coreScaled * primaryWeight) / weightSum
  : coreScaled;
  split[input.primaryAttr] = Math.round(primaryCoreShare);
  if (hasSecondary) {
  split[input.secondaryAttr as AttrKey] = Math.round(
  (coreScaled * secondaryWeight) / weightSum,
  );
  }
  const willBonusRounded = Math.round(willScaled);
  if (willBonusRounded > 0) {
  split.willpower = (split.willpower ?? 0) + willBonusRounded;
  }

  // 取整误差并入主属性，保证合计 === xpAwarded
  const sum = Object.values(split).reduce((a, b) => a + b, 0);
  split[input.primaryAttr] =
  (split[input.primaryAttr] ?? 0) + (xpAwarded - sum);

  return {
  questXpRaw: rawTotal,
  xpAwarded,
  goldAwarded,
  attrSplit: split,
  multipliers: { streak: streakMult, over: overMult, total: totalMult },
  };
}

/**
 * 难度下调补偿（“炉火纯青”事件）：
 * 补偿 XP = 该任务基准 XP × 10
 */
export function calibrationCompensationXp(type: QuestType): number {
  return (
  config.quest_base[type].xp *
  config.difficulty.calibration_compensation_multiplier
  );
}
