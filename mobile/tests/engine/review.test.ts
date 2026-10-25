import { describe, it, expect, afterEach } from "vitest";
import {
  applyReviewAdjustments,
  isVerdictActionable,
  type ReviewInput,
  type ReviewVerdict,
} from "../src/server/engine/review";
import { config } from "../src/server/engine/config";

/** 默认输入：daily 难度 1、入账 10 XP、mind 70%/willpower 30% 分流（含连击加成 1） */
function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    awardedXp: 10,
    attrSplit: { mind: 6, willpower: 4 },
    primaryAttr: "mind",
    secondaryAttr: "willpower",
    category: "课程学习",
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    no_adjustment: false,
    xp_bonus_ratio: 0,
    bonus_allocations: [],
    reclassification: null,
    narrative_hint: "",
    confidence: 0.9,
    ...overrides,
  };
}

const originalReview = { ...config.review };

afterEach(() => {
  config.review.enabled = originalReview.enabled;
  config.review.min_confidence = originalReview.min_confidence;
  config.review.bonus_cap_ratio = originalReview.bonus_cap_ratio;
});

function sumDeltas(deltas: Record<string, number>): number {
  return Object.values(deltas).reduce((a, b) => a + b, 0);
}

describe("收获复核引擎（V1.5 护栏）", () => {
  it("no_adjustment：不应用，narrative_hint 作为原因返回", () => {
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ no_adjustment: true, narrative_hint: "完全按计划交付" }),
    );
    expect(r.applied).toBe(false);
    expect(r.xpDelta).toBe(0);
    expect(r.reason).toBe("完全按计划交付");
  });

  it("复核开关关闭（economy_config review.enabled=false）时不应用", () => {
    config.review.enabled = false;
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ xp_bonus_ratio: 0.5 }),
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("未启用");
  });

  it("置信度低于门槛（min_confidence）时不应用", () => {
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ confidence: 0.4 }),
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("置信度不足");
    expect(isVerdictActionable(makeVerdict({ confidence: 0.4 }))).toBe(false);
  });

  it("isVerdictActionable：开关/无调整/置信度三道前置", () => {
    expect(isVerdictActionable(makeVerdict())).toBe(true);
    expect(isVerdictActionable(makeVerdict({ no_adjustment: true }))).toBe(false);
    config.review.enabled = false;
    expect(isVerdictActionable(makeVerdict())).toBe(false);
  });

  it("追加 XP：按分配项分流，Σ attrDeltas === xpDelta", () => {
    const r = applyReviewAdjustments(
      makeInput({ awardedXp: 10, category: "创作交付", primaryAttr: "creativity", secondaryAttr: "mind", attrSplit: { creativity: 6, mind: 4 } }),
      makeVerdict({
        xp_bonus_ratio: 0.5,
        bonus_allocations: [
          { attr: "mind", share: 0.5, reason: "质量超预期" },
          { attr: "creativity", share: 0.5, reason: "计划外做了笔记模板" },
        ],
        narrative_hint: "额外认可创造",
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.xpDelta).toBe(5); // 10 × 0.5
    expect(sumDeltas(r.attrDeltas)).toBe(5);
    expect(r.attrDeltas.creativity).toBeGreaterThan(0);
    expect(r.reason).toBe("额外认可创造");
  });

  it("追加 XP：比例超过 bonus_cap_ratio 时被钳制（总调整 ≤1.5×）", () => {
    const r = applyReviewAdjustments(
      makeInput({ awardedXp: 10 }),
      makeVerdict({
        xp_bonus_ratio: 0.9, // 远超 0.5 上限
        bonus_allocations: [{ attr: "mind", share: 1, reason: "超额" }],
      }),
    );
    expect(r.xpDelta).toBe(5); // 钳制到 10 × 0.5
  });

  it("追加分配 willpower 被剥离（意志经验由代码独占）", () => {
    const r = applyReviewAdjustments(
      makeInput({ category: "独自运动", primaryAttr: "vitality", secondaryAttr: "willpower", attrSplit: { vitality: 8, willpower: 2 } }),
      makeVerdict({
        xp_bonus_ratio: 0.5,
        bonus_allocations: [{ attr: "willpower", share: 1, reason: "想分给意志" }],
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.dropped.join()).toContain("willpower");
    // 兜底记入主属性 vitality，不掉经验
    expect(r.attrDeltas.vitality).toBe(5);
    expect(r.attrDeltas.willpower).toBeUndefined();
  });

  it("追加分配越界属性被剥离，其余正常分流", () => {
    const r = applyReviewAdjustments(
      makeInput({ category: "收入记账", primaryAttr: "wealth", secondaryAttr: null, attrSplit: { wealth: 10 } }),
      makeVerdict({
        xp_bonus_ratio: 0.5,
        bonus_allocations: [
          { attr: "wealth", share: 0.5, reason: "记账习惯本身" },
          { attr: "mind", share: 0.5, reason: "越界分配" },
        ],
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.dropped.join()).toContain("mind 越界");
    expect(r.attrDeltas.wealth).toBe(5);
    expect(r.attrDeltas.mind).toBeUndefined();
  });

  it("判定器只给比例未给分配：兜底记入主属性", () => {
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ xp_bonus_ratio: 0.2, bonus_allocations: [] }),
    );
    expect(r.applied).toBe(true);
    expect(r.attrDeltas.mind).toBe(2);
    expect(r.dropped.join()).toContain("未给追加分配");
  });

  it("无类别（V1 老数据）按主属性反查白名单：vitality → 独自运动，social 越界被剥", () => {
    const r = applyReviewAdjustments(
      makeInput({
        category: null,
        primaryAttr: "vitality",
        secondaryAttr: "willpower",
        attrSplit: { vitality: 6, willpower: 4 },
      }),
      makeVerdict({
        xp_bonus_ratio: 1,
        bonus_allocations: [
          { attr: "vitality", share: 0.5, reason: "正常" },
          { attr: "social", share: 0.5, reason: "越界" },
        ],
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.dropped.join()).toContain("social 越界");
    expect(r.attrDeltas.vitality).toBe(5);
    expect(r.attrDeltas.social).toBeUndefined();
  });

  it("取整闭合：入账 7 XP × 0.5 → 4 XP（四舍五入），Σ === xpDelta", () => {
    const r = applyReviewAdjustments(
      makeInput({ awardedXp: 7, category: "创作交付", primaryAttr: "creativity", secondaryAttr: "mind", attrSplit: { creativity: 4, mind: 3 } }),
      makeVerdict({
        xp_bonus_ratio: 0.5,
        bonus_allocations: [
          { attr: "creativity", share: 0.34, reason: "a" },
          { attr: "mind", share: 0.33, reason: "b" },
          { attr: "creativity", share: 0.33, reason: "c" },
        ],
      }),
    );
    expect(r.xpDelta).toBe(4);
    expect(sumDeltas(r.attrDeltas)).toBe(4);
  });

  it("重分类：原主属性份额整体转移给新属性，连击部分（willpower）不动", () => {
    const r = applyReviewAdjustments(
      makeInput({ attrSplit: { mind: 6, willpower: 4 }, category: "创作交付" }),
      makeVerdict({
        reclassification: { attr: "creativity", reason: "实际是创作交付" },
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.xpDelta).toBe(0);
    expect(r.reclassified).toEqual({ from: "mind", to: "creativity", xp: 6 });
    expect(r.attrDeltas.mind).toBe(-6);
    expect(r.attrDeltas.creativity).toBe(6);
    expect(r.attrDeltas.willpower).toBeUndefined(); // 连击经验不被触碰
    expect(sumDeltas(r.attrDeltas)).toBe(0);
  });

  it("重分类到原辅属性：份额合并到该属性", () => {
    const r = applyReviewAdjustments(
      makeInput({ attrSplit: { mind: 6, willpower: 4 }, category: "创作交付" }),
      makeVerdict({
        reclassification: { attr: "creativity", reason: "性质错了" },
      }),
    );
    // creativity 原本无份额，与上一个用例相同转移行为
    expect(r.reclassified).toEqual({ from: "mind", to: "creativity", xp: 6 });
  });

  it("重分类被拒：原主属性为 willpower（防转移代码独占的连击经验）", () => {
    const r = applyReviewAdjustments(
      makeInput({
        category: "戒断早起",
        primaryAttr: "willpower",
        secondaryAttr: "vitality",
        attrSplit: { willpower: 9, vitality: 1 },
      }),
      makeVerdict({ reclassification: { attr: "vitality", reason: "其实是运动" } }),
    );
    expect(r.applied).toBe(false);
    expect(r.dropped.join()).toContain("willpower 的经验由代码独占");
  });

  it("重分类目标 willpower 被拒绝", () => {
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ reclassification: { attr: "willpower", reason: "想给意志" } }),
    );
    expect(r.applied).toBe(false);
    expect(r.dropped.join()).toContain("重分类目标 willpower");
  });

  it("重分类目标越界被拒绝", () => {
    const r = applyReviewAdjustments(
      makeInput(),
      makeVerdict({ reclassification: { attr: "social", reason: "越界" } }),
    );
    expect(r.applied).toBe(false);
    expect(r.dropped.join()).toContain("social 越界");
  });

  it("追加 + 重分类同时发生：xpDelta 只含追加，重分类净额为 0", () => {
    const r = applyReviewAdjustments(
      makeInput({ attrSplit: { mind: 6, willpower: 4 }, category: "创作交付" }),
      makeVerdict({
        xp_bonus_ratio: 0.5,
        bonus_allocations: [{ attr: "creativity", share: 1, reason: "副产品" }],
        reclassification: { attr: "creativity", reason: "性质错了" },
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.xpDelta).toBe(5);
    expect(r.attrDeltas.mind).toBe(-6);
    expect(r.attrDeltas.creativity).toBe(6 + 5);
    expect(sumDeltas(r.attrDeltas)).toBe(5);
  });

  it("入账 XP 为 0（部分结算为 0）时不应用", () => {
    const r = applyReviewAdjustments(
      makeInput({ awardedXp: 0, attrSplit: {} }),
      makeVerdict({ xp_bonus_ratio: 0.5 }),
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("无可调整");
  });
});

describe("收获复核引擎 · 每日软上限联动", () => {
  it("当日已入账接近软上限时，追加部分按 ×0.3 折算（AGENTS.md §7）", () => {
    // 原结算入账 10，当日已入账 145（含本次）→ 追加 5 中只有 5 全额内剩余 5？：
    // todaySettled(不含本次)=135，105+10=115，剩余全额空间 150-145=5 → 追加 5 全额
    const r1 = applyReviewAdjustments(
      makeInput({ awardedXp: 10 }),
      makeVerdict({ xp_bonus_ratio: 0.5, bonus_allocations: [{ attr: "mind", share: 1, reason: "a" }] }),
    );
    // 不传 todaySettledXp：不受软上限影响（复核引擎自身已钳 0.5）
    expect(r1.xpDelta).toBe(5);

    // 当日已入账 148（含本次）→ 全额空间剩 2，追加 5 → 2 + (5-2)×0.3 ≈ 2.9 → 3
    const r2 = applyReviewAdjustments(
      makeInput({ awardedXp: 10, todaySettledXp: 138 }),
      makeVerdict({ xp_bonus_ratio: 0.5, bonus_allocations: [{ attr: "mind", share: 1, reason: "a" }] }),
    );
    expect(r2.xpDelta).toBe(3);
    expect(r2.attrDeltas.mind).toBe(3);
  });
});
