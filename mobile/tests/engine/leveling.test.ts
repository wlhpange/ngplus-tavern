import { describe, it, expect } from "vitest";
import {
  xpRequiredForNextLevel,
  levelFromXp,
  xpToNextLevel,
  rankFromLevel,
  promotedRank,
  rankUpGoldReward,
} from "../src/server/engine/leveling";

describe("升级曲线 150 + 100×(N-1)", () => {
  it("各级所需 XP", () => {
    expect(xpRequiredForNextLevel(1)).toBe(150);
    expect(xpRequiredForNextLevel(2)).toBe(250);
    expect(xpRequiredForNextLevel(3)).toBe(350);
    expect(xpRequiredForNextLevel(4)).toBe(450);
  });

  it("levelFromXp 边界：149→1 级，150→2 级", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(149)).toBe(1);
    expect(levelFromXp(150)).toBe(2);
  });

  it("levelFromXp 累计边界：399→2 级，400→3 级", () => {
    expect(levelFromXp(399)).toBe(2);
    expect(levelFromXp(400)).toBe(3);
  });

  it("levelFromXp：750→4 级，1200→5 级", () => {
    expect(levelFromXp(749)).toBe(3);
    expect(levelFromXp(750)).toBe(4);
    expect(levelFromXp(1200)).toBe(5);
  });

  it("xpToNextLevel：进度条剩余量", () => {
    expect(xpToNextLevel(0)).toBe(150);
    expect(xpToNextLevel(150)).toBe(250);
    expect(xpToNextLevel(200)).toBe(200);
  });
});

describe("冒险者评级映射边界（F→S）", () => {
  const cases: Array<[number, string]> = [
    [1, "F"],
    [4, "F"],
    [5, "E"],
    [9, "E"],
    [10, "D"],
    [14, "D"],
    [15, "C"],
    [21, "C"],
    [22, "B"],
    [30, "B"],
    [31, "A"],
    [40, "A"],
    [41, "S"],
    [100, "S"],
  ];
  it.each(cases)("等级 %i → %s 级冒险者", (level, rank) => {
    expect(rankFromLevel(level)).toBe(rank);
  });
});

describe("评级只升不降", () => {
  it("等级提升跨档 → 晋升", () => {
    expect(promotedRank("F", 5)).toEqual({ rank: "E", promoted: true });
  });

  it("等级未跨档 → 不晋升", () => {
    expect(promotedRank("F", 4)).toEqual({ rank: "F", promoted: false });
  });

  it("当前评级高于等级映射 → 维持当前评级（不降）", () => {
    expect(promotedRank("C", 3)).toEqual({ rank: "C", promoted: false });
  });
});

describe("晋升酬金 = 评级序数 × 200", () => {
  it("F→S 序数 1~7", () => {
    expect(rankUpGoldReward("F")).toBe(200);
    expect(rankUpGoldReward("D")).toBe(600);
    expect(rankUpGoldReward("S")).toBe(1400);
  });
});
