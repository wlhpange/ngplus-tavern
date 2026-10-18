import { config } from "./config";

/**
 * 连击加成倍率：1 + 5% × streak，上限 1.5（被动技能可提高上限）
 * @param capAdd 连击上限加成（被动技能，如 0.15 → 上限 1.65）
 */
export function streakBonusMultiplier(streak: number, capAdd = 0): number {
  const { bonus_per_day, bonus_cap } = config.streak;
  return Math.min(1 + bonus_per_day * streak, bonus_cap + capAdd);
}

export function incrementStreak(streak: number): number {
  return streak + 1;
}

export interface StreakBreakResult {
  /** 断签后的 streak 数 */
  streak: number;
  /** 断签后的连击加成倍率 */
  bonusMultiplier: number;
  /** 是否已清零 */
  reset: boolean;
}

/**
 * 断签处理（ + 断签软机制）：
 * - 首次断签：streak 数保留，连击加成减半
 * - 连续第二天再断：streak 清零
 *
 * DESIGN-DECISION: “连击加成减半”按加成部分减半实现（如 +50% → +25%，
 * 即倍率 1.5 → 1.25），与经济文档示例一致；而非倍率整体减半（1.5 → 0.75 会变成倒扣）。
 *
 * @param consecutiveBreaks 截至本次已连续断签天数（含本次）
 */
export function applyStreakBreak(
  streak: number,
  consecutiveBreaks: number,
): StreakBreakResult {
  if (consecutiveBreaks >= config.streak.consecutive_breaks_to_reset) {
  return { streak: 0, bonusMultiplier: 1, reset: true };
  }
  const full = streakBonusMultiplier(streak);
  const halved = 1 + (full - 1) * config.streak.break_decay_multiplier;
  return { streak, bonusMultiplier: halved, reset: false };
}
