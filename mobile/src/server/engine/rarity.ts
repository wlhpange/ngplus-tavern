import { config } from "./config";

/**
 * V1.8 单次/每周任务稀有奖励：
 * 结算时引擎掷一次稀有度，只放大金币（XP 不动——数值成长通道不受赌博影响）。
 * rand 可注入：单测传固定值覆盖全部分支。
 */

export type Rarity = "common" | "rare" | "legendary";

export interface RarityRoll {
  rarity: Rarity;
  /** 金币乘数：common=1 */
  multiplier: number;
}

export function applyOnceBonus(
  baseGold: number,
  questType: "daily" | "once" | "weekly" | "mainline_milestone",
  rand: () => number = Math.random,
): { gold: number; roll: RarityRoll } {
  if (questType !== "once" && questType !== "weekly") {
  return { gold: baseGold, roll: { rarity: "common", multiplier: 1 } };
  }
  const roll = rand();
  const { chance_legendary, chance_rare, multiplier_legendary, multiplier_rare } =
  config.once_bonus;
  if (roll < chance_legendary) {
  return {
  gold: Math.round(baseGold * multiplier_legendary),
  roll: { rarity: "legendary", multiplier: multiplier_legendary },
  };
  }
  if (roll < chance_legendary + chance_rare) {
  return {
  gold: Math.round(baseGold * multiplier_rare),
  roll: { rarity: "rare", multiplier: multiplier_rare },
  };
  }
  return { gold: baseGold, roll: { rarity: "common", multiplier: 1 } };
}

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "",
  rare: "稀有品质！",
  legendary: "传说品质！！",
};
