import { describe, it, expect } from "vitest";
import {
  settleQuest,
  applyDailySoftCap,
  calibrationCompensationXp,
  type SettleInput,
} from "../src/server/engine/settlement";

const baseInput: SettleInput = {
  type: "daily",
  difficulty: 1,
  streak: 0,
  completionRatio: 1,
  primaryAttr: "vitality",
  todaySettledXp: 0,
};

describe("settleQuest · 基准产出", () => {
  it("daily 基准：XP 10 / 金币 5，无辅属性时主属性 100%", () => {
    const r = settleQuest(baseInput);
    expect(r.questXpRaw).toBe(10);
    expect(r.xpAwarded).toBe(10);
    expect(r.goldAwarded).toBe(5);
    expect(r.attrSplit).toEqual({ vitality: 10 });
  });

  it("once/weekly/mainline 基准值正确", () => {
    expect(settleQuest({ ...baseInput, type: "once" }).xpAwarded).toBe(25);
    expect(settleQuest({ ...baseInput, type: "weekly" }).xpAwarded).toBe(30);
    expect(
      settleQuest({ ...baseInput, type: "mainline_milestone" }).xpAwarded,
    ).toBe(120);
    expect(settleQuest({ ...baseInput, type: "once" }).goldAwarded).toBe(10);
    expect(settleQuest({ ...baseInput, type: "weekly" }).goldAwarded).toBe(15);
    expect(
      settleQuest({ ...baseInput, type: "mainline_milestone" }).goldAwarded,
    ).toBe(60);
  });
});

describe("settleQuest · 基准 × 难度 × 连击 × 超额组合", () => {
  it("难度线性作用于 XP 与金币", () => {
    const r = settleQuest({ ...baseInput, difficulty: 2 });
    expect(r.questXpRaw).toBe(20);
    expect(r.goldAwarded).toBe(10);
  });

  it("连击加成：streak 10 → ×1.5（达上限）", () => {
    const r = settleQuest({ ...baseInput, streak: 10 });
    expect(r.multipliers.streak).toBe(1.5);
    expect(r.questXpRaw).toBe(15);
  });

  it("连击加成未达上限：streak 4 → ×1.2", () => {
    const r = settleQuest({ ...baseInput, streak: 4 });
    expect(r.multipliers.streak).toBeCloseTo(1.2);
    expect(r.questXpRaw).toBeCloseTo(12);
  });

  it("连击加成封顶 1.5：streak 100 仍为 ×1.5", () => {
    const r = settleQuest({ ...baseInput, streak: 100 });
    expect(r.multipliers.streak).toBe(1.5);
    expect(r.questXpRaw).toBe(15);
  });

  it("超额系数：ratio 1.2 → 启用超额，无连击时 ×1.2", () => {
    const r = settleQuest({ ...baseInput, completionRatio: 1.2 });
    expect(r.multipliers.over).toBe(1.2);
    expect(r.questXpRaw).toBeCloseTo(12);
  });

  it("总乘区上限 1.5：streak 10（×1.5）+ ratio 1.2 → 仍 ×1.5", () => {
    const r = settleQuest({
      ...baseInput,
      type: "once",
      difficulty: 2,
      streak: 10,
      completionRatio: 1.2,
    });
    expect(r.multipliers.total).toBe(1.5);
    expect(r.questXpRaw).toBe(25 * 2 * 1.5);
    expect(r.xpAwarded).toBe(75);
  });

  it("ratio ≤ 1 不启用超额系数，按比例部分结算", () => {
    const r = settleQuest({ ...baseInput, completionRatio: 0.5 });
    expect(r.multipliers.over).toBe(1);
    expect(r.questXpRaw).toBe(5);
  });
});

describe("settleQuest · 金币不吃连击/超额", () => {
  it("streak 10 + ratio 1.5 时金币仍只有 基准×难度", () => {
    const r = settleQuest({
      ...baseInput,
      difficulty: 2,
      streak: 10,
      completionRatio: 1.5,
    });
    expect(r.goldAwarded).toBe(5 * 2);
    expect(r.questXpRaw).toBe(10 * 2 * 1.5);
  });
});

describe("applyDailySoftCap · 每日软上限边界", () => {
  it("未触及上限：已结算 100 + 本次 10 → 全额 10", () => {
    expect(applyDailySoftCap(10, 100)).toBe(10);
  });

  it("边界 149：已结算 149 + 本次 10 → 1 全额 + 9×0.3 = 3.7", () => {
    expect(applyDailySoftCap(10, 149)).toBeCloseTo(3.7);
  });

  it("边界 150：已结算 150 + 本次 10 → 全部超额 10×0.3 = 3", () => {
    expect(applyDailySoftCap(10, 150)).toBeCloseTo(3);
  });

  it("边界 151：已结算 151（已超限）+ 本次 10 → 仍全部 ×0.3", () => {
    expect(applyDailySoftCap(10, 151)).toBeCloseTo(3);
  });

  it("恰满 150：已结算 110 + 本次 10 → 全额", () => {
    expect(applyDailySoftCap(10, 110)).toBe(10);
  });

  it("结算时软上限作用于最终入账 XP", () => {
    const r = settleQuest({
      ...baseInput,
      type: "mainline_milestone",
      todaySettledXp: 100,
    });
    // 软上限 150，今日已入账 100 → 剩余 50 全额 + 70×0.3 = 71
    expect(r.questXpRaw).toBe(120);
    expect(r.xpAwarded).toBe(71);
  });
});

describe("settleQuest · 属性分流", () => {
  it("主辅 0.6/0.4 权重分流核心部分", () => {
    const r = settleQuest({
      ...baseInput,
      type: "once",
      primaryAttr: "mind",
      primaryWeight: 0.6,
      secondaryAttr: "willpower",
      secondaryWeight: 0.4,
    });
    // raw 25，无连击，willpower 追加为 0：mind 15 + willpower 10
    expect(r.attrSplit.mind).toBe(15);
    expect(r.attrSplit.willpower).toBe(10);
    expect(
      Object.values(r.attrSplit).reduce((a, b) => a + b, 0),
    ).toBe(r.xpAwarded);
  });

  it("连击加成部分由代码追加到 willpower，不参与权重分流", () => {
    const r = settleQuest({
      ...baseInput,
      streak: 10, // ×1.5 → raw 15，其中连击加成 5 追加 willpower
      primaryAttr: "vitality",
    });
    expect(r.attrSplit.vitality).toBe(10);
    expect(r.attrSplit.willpower).toBe(5);
  });

  it("主属性本身是 willpower 时两部分合并", () => {
    const r = settleQuest({
      ...baseInput,
      streak: 10,
      primaryAttr: "willpower",
    });
    expect(r.attrSplit.willpower).toBe(15);
  });

  it("分流取整后合计恒等于 xpAwarded", () => {
    const r = settleQuest({
      ...baseInput,
      type: "weekly",
      difficulty: 1.3,
      streak: 3,
      completionRatio: 1.1,
      primaryAttr: "creativity",
      primaryWeight: 0.7,
      secondaryAttr: "mind",
      secondaryWeight: 0.3,
      todaySettledXp: 0,
    });
    expect(
      Object.values(r.attrSplit).reduce((a, b) => a + b, 0),
    ).toBe(r.xpAwarded);
  });
});

describe("calibrationCompensationXp · 难度下调补偿", () => {
  it("补偿 = 基准 XP × 10", () => {
    expect(calibrationCompensationXp("daily")).toBe(100);
    expect(calibrationCompensationXp("once")).toBe(250);
    expect(calibrationCompensationXp("weekly")).toBe(300);
    expect(calibrationCompensationXp("mainline_milestone")).toBe(1200);
  });
});
