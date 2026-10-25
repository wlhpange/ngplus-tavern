import { config } from "./config";

/**
 * 升级所需 XP（N → N+1）= 150 + 100 × (N-1)
 * 总等级与属性等级共用本曲线
 */
export function xpRequiredForNextLevel(level: number): number {
  return (
  config.leveling.base_xp + config.leveling.increment_per_level * (level - 1)
  );
}

/** 由累计 XP 反推等级（1 级起步） */
export function levelFromXp(xp: number): number {
  let level = 1;
  let remaining = xp;
  while (remaining >= xpRequiredForNextLevel(level)) {
  remaining -= xpRequiredForNextLevel(level);
  level += 1;
  }
  return level;
}

/** 距下一级还需多少 XP（用于进度条） */
export function xpToNextLevel(xp: number): number {
  const level = levelFromXp(xp);
  let spent = 0;
  for (let n = 1; n < level; n++) spent += xpRequiredForNextLevel(n);
  return xpRequiredForNextLevel(level) - (xp - spent);
}

/** 总等级 → 冒险者评级（F→S），阈值读 economy_config.json() 的 ranks */
export function rankFromLevel(level: number): string {
  for (const r of config.ranks) {
  if (level >= r.min_level && (r.max_level === null || level <= r.max_level)) {
  return r.rank;
  }
  }
  throw new Error(`no rank found for level ${level}`);
}

/** 评级序数：F=1 … S=7 */
export function rankIndex(rank: string): number {
  const idx = config.ranks.findIndex((r) => r.rank === rank);
  if (idx < 0) throw new Error(`unknown rank ${rank}`);
  return idx + 1;
}

/**
 * 评级只升不降判定辅助：
 * 按等级算出的评级低于当前评级时，维持当前评级
 */
export function promotedRank(
  currentRank: string,
  totalLevel: number,
): { rank: string; promoted: boolean } {
  const byLevel = rankFromLevel(totalLevel);
  if (rankIndex(byLevel) > rankIndex(currentRank)) {
  return { rank: byLevel, promoted: true };
  }
  return { rank: currentRank, promoted: false };
}

/** 晋升一次性酬金 = 评级序数 × 200 金币 */
export function rankUpGoldReward(rank: string): number {
  return rankIndex(rank) * config.rank_reward.gold_per_rank_index;
}

/**
 * 面板用：当前评级 + 下一评级及所差等级数（只读展示，不改任何公式）
 * 已是最高评级（S）时 next 为 null
 */
export function rankBadgeInfo(totalLevel: number): {
  current: string;
  next: { rank: string; levelsNeeded: number } | null;
} {
  const current = rankFromLevel(totalLevel);
  const idx = config.ranks.findIndex((r) => r.rank === current);
  const nextRank = config.ranks[idx + 1];
  if (!nextRank) return { current, next: null };
  return {
  current,
  next: {
  rank: nextRank.rank,
  levelsNeeded: Math.max(0, nextRank.min_level - totalLevel),
  },
  };
}

/** 全部评级档位（供徽章列表展示），阈值读 economy_config.json() */
export function allRanks(): { rank: string; minLevel: number }[] {
  return config.ranks.map((r) => ({ rank: r.rank, minLevel: r.min_level }));
}
