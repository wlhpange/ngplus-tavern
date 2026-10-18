/**
 * 设置页的彩蛋：连点若干下解锁隐藏功能。
 * 抽成纯函数便于单测；组件只负责把点击时间戳喂进来。
 */

/** 需要连点几下 */
export const SECRET_TAPS = 5;
/** 相邻点击允许的最大间隔（毫秒）——超过就从头数 */
export const SECRET_WINDOW_MS = 4000;

export interface SecretTapResult {
  /** 更新后的点击时间戳序列（已达阈值则清空） */
  taps: number[];
  /** 本次点击是否恰好达成解锁 */
  unlocked: boolean;
}

/** 记录一次点击，返回新的时间戳序列与是否达成解锁 */
export function registerSecretTap(taps: number[], now: number): SecretTapResult {
  const next = [...taps, now].filter((t) => now - t <= SECRET_WINDOW_MS);
  if (next.length >= SECRET_TAPS) {
    return { taps: [], unlocked: true };
  }
  return { taps: next, unlocked: false };
}
