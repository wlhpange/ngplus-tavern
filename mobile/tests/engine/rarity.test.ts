import { describe, it, expect } from "vitest";
import { applyOnceBonus } from "../src/server/engine/rarity";

describe("单次/每周稀有奖励（V1.8）", () => {
  const cases: [number, string, number][] = [
    [0.02, "legendary", 90],   // 75 × 3（once 难度1 基准 25×3=75? 基准金币 10×3=30×3=90）
    [0.2, "rare", 45],         // 30 × 1.5
    [0.9, "common", 30],       // 无加成
  ];
  for (const [roll, rarity, gold] of cases) {
    it(`rand=${roll} → ${rarity}，金币 ${gold}`, () => {
      const r = applyOnceBonus(30, "once", () => roll);
      expect(r.roll.rarity).toBe(rarity);
      expect(r.gold).toBe(gold);
    });
  }

  it("daily/里程碑不参与掷骰", () => {
    const r = applyOnceBonus(15, "daily", () => 0.01);
    expect(r.roll.rarity).toBe("common");
    expect(r.gold).toBe(15);
  });

  it("稀有度概率边界：恰在 chance_legendary 处归 rare", () => {
    const r = applyOnceBonus(30, "once", () => 0.05);
    expect(r.roll.rarity).toBe("rare");
  });
});
