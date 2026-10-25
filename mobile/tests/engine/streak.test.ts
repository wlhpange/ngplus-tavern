import { describe, it, expect } from "vitest";
import {
  streakBonusMultiplier,
  incrementStreak,
  applyStreakBreak,
} from "../src/server/engine/streak";

describe("streakBonusMultiplier", () => {
  it("streak 0 → ×1.0", () => {
    expect(streakBonusMultiplier(0)).toBe(1);
  });

  it("streak 4 → ×1.2（1 + 5%×4）", () => {
    expect(streakBonusMultiplier(4)).toBeCloseTo(1.2);
  });

  it("streak 10 达到上限 ×1.5", () => {
    expect(streakBonusMultiplier(10)).toBe(1.5);
  });

  it("streak 超过 10 仍封顶 ×1.5", () => {
    expect(streakBonusMultiplier(40)).toBe(1.5);
  });
});

describe("incrementStreak", () => {
  it("连击 +1", () => {
    expect(incrementStreak(6)).toBe(7);
  });
});

describe("applyStreakBreak · 断签软机制", () => {
  it("首次断签：streak 保留，加成减半（+50% → +25%）", () => {
    const r = applyStreakBreak(40, 1);
    expect(r.streak).toBe(40);
    expect(r.reset).toBe(false);
    expect(r.bonusMultiplier).toBeCloseTo(1.25);
  });

  it("首次断签且未达上限：streak 4（×1.2）→ ×1.1", () => {
    const r = applyStreakBreak(4, 1);
    expect(r.streak).toBe(4);
    expect(r.bonusMultiplier).toBeCloseTo(1.1);
  });

  it("连续第二天断签：streak 清零，加成归零", () => {
    const r = applyStreakBreak(40, 2);
    expect(r.streak).toBe(0);
    expect(r.bonusMultiplier).toBe(1);
    expect(r.reset).toBe(true);
  });

  it("连续更多天断签：保持清零", () => {
    const r = applyStreakBreak(40, 3);
    expect(r.reset).toBe(true);
    expect(r.streak).toBe(0);
  });
});
