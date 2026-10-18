import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import {
  character,
  chatLog,
  disputes,
  quests,
  settlementLog,
  titles,
} from "../../src/server/db/schema";
import { runSettlementReview } from "../../src/server/reviewPipeline";
import type { SettlementReviewer, ReviewContext } from "../../src/server/llm/reviewer";
import type { ReviewVerdict } from "../../src/server/engine/review";
import { config } from "../../src/server/engine/config";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

/** 造一笔已落账的结算（daily 晨跑：vitality 70% / willpower 30%，入账 10 XP） */
function seedSettlement(overrides: Partial<typeof settlementLog.$inferInsert> = {}) {
  db.insert(quests)
    .values({
      id: "q1",
      userId,
      title: "晨跑",
      type: "daily",
      category: "独自运动",
      primaryAttr: "vitality",
      primaryWeight: 0.7,
      secondaryAttr: "willpower",
      secondaryWeight: 0.3,
      difficulty: 1,
      status: "active",
      streak: 1,
      createdAt: Date.now(),
    })
    .run();
  const id = overrides.id ?? "s1";
  db.insert(settlementLog)
    .values({
      id,
      userId,
      questId: "q1",
      kind: "quest_complete",
      completionRatio: 1,
      confidence: 0.9,
      xpAwarded: 10,
      goldAwarded: 5,
      attrSplitJson: JSON.stringify({ vitality: 7, willpower: 3 }),
      llmReasoning: "跑了三公里，微微出汗",
      createdAt: Date.now(),
      ...overrides,
    })
    .run();
  // 模拟结算后的角色状态（原结算已入账：10 XP / vitality 7 / willpower 3 / gold 5）
  db.update(character)
    .set({ totalXp: 10, gold: 5, vitalityXp: 7, willpowerXp: 3 })
    .where(eq(character.userId, userId))
    .run();
  return id;
}

/** 可编程 fake 判定器 */
function fakeReviewer(
  verdict: ReviewVerdict | null | Error,
  calls: ReviewContext[] = [],
): SettlementReviewer {
  return {
    async review(ctx) {
      calls.push(ctx);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

const bonusVerdict: ReviewVerdict = {
  no_adjustment: false,
  xp_bonus_ratio: 0.5,
  bonus_allocations: [
    { attr: "vitality", share: 0.5, reason: "跑量超预期" },
    { attr: "mind", share: 0.5, reason: "计划外做了拉伸笔记" },
  ],
  reclassification: null,
  narrative_hint: "计划外的战果也是战果",
  confidence: 0.92,
};

beforeEach(() => {
  config.review.enabled = true;
});

describe("复核管线（V1.5）", () => {
  it("追加采纳：XP/属性入账、review_adjustment 留痕、提示条与叙事指令齐备", async () => {
    const settlementId = seedSettlement();
    const calls: ReviewContext[] = [];
    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer(bonusVerdict, calls),
    });

    expect(outcome.ran).toBe(true);
    expect(outcome.applied).toBe(true);
    // 入账 10 × 0.5 = 5（当日仅此一笔，软上限内全额）
    expect(outcome.notice).toContain("收获复核");
    expect(outcome.systemMessage).toContain("计划外的收获");
    expect(outcome.systemMessage).not.toContain("+5");

    // 判定器收到并排上下文：预设映射 + 实际汇报
    expect(calls[0].category).toBe("独自运动");
    expect(calls[0].evidence).toContain("三公里");
    expect(calls[0].awardedXp).toBe(10);

    // 留痕：review_adjustment 行 + adjustments_json 完整
    const log = db
      .select()
      .from(settlementLog)
      .where(eq(settlementLog.kind, "review_adjustment"))
      .get()!;
    expect(log.xpAwarded).toBe(5);
    const adj = JSON.parse(log.adjustmentsJson!) as {
      verdict: ReviewVerdict;
      applied: { xp_delta: number; dropped: string[] };
    };
    expect(adj.verdict.narrative_hint).toBe("计划外的战果也是战果");
    expect(adj.applied.xp_delta).toBe(5);
    expect(adj.applied.dropped.join()).toContain("mind 越界");

    // 角色对账：totalXp = 10 + 5；独自运动白名单 [vitality, willpower]，
    // mind 分配被护栏剥离 → 追加全额归 vitality；willpower 不动
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(15);
    expect(c.vitalityXp).toBe(12);
    expect(c.mindXp).toBe(0);
    expect(c.willpowerXp).toBe(3);

    // 对话留痕
    const logs = db.select().from(chatLog)
      .where(and(eq(chatLog.role, "system"), eq(chatLog.userId, userId))).all();
    expect(logs.some((l) => l.content.includes("[复核]"))).toBe(true);
  });

  it("重分类采纳：总 XP 不动，主属性份额转移，willpower 连击部分不动", async () => {
    const settlementId = seedSettlement();
    // 换到 创作交付（[creativity, mind]），重分类目标 mind 在白名单内
    db.update(quests)
      .set({ category: "创作交付", primaryAttr: "creativity", secondaryAttr: "mind" })
      .where(eq(quests.id, "q1"))
      .run();
    db.update(settlementLog)
      .set({ attrSplitJson: JSON.stringify({ creativity: 7, mind: 3 }) })
      .where(eq(settlementLog.id, settlementId))
      .run();
    db.update(character)
      .set({ vitalityXp: 0, willpowerXp: 0, creativityXp: 7, mindXp: 3 })
      .where(eq(character.userId, userId))
      .run();

    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer({
        no_adjustment: false,
        xp_bonus_ratio: 0,
        bonus_allocations: [],
        reclassification: { attr: "mind", reason: "实际是冥想式创作，心智为主" },
        narrative_hint: "重新归类",
        confidence: 0.88,
      }),
    });

    expect(outcome.applied).toBe(true);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(10); // 重分类净额 0
    expect(c.creativityXp).toBe(0); // 原主属性 7 份转出
    expect(c.mindXp).toBe(10); // 3 + 7
    expect(c.vitalityXp).toBe(0);
  });

  it("no_adjustment：不写任何账，维持原判", async () => {
    const settlementId = seedSettlement();
    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer({
        no_adjustment: true,
        xp_bonus_ratio: 0,
        bonus_allocations: [],
        reclassification: null,
        narrative_hint: "完全按计划",
        confidence: 0.95,
      }),
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.notice).toBe("");
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(10);
    expect(
      db.select().from(settlementLog).where(eq(settlementLog.kind, "review_adjustment")).all(),
    ).toHaveLength(0);
  });

  it("判定器抛错：fail-open，结算不受影响", async () => {
    const settlementId = seedSettlement();
    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer(new Error("deepseek down")),
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.applied).toBe(false);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(10);
  });

  it("置信度低于门槛：引擎拒绝，不应用", async () => {
    const settlementId = seedSettlement();
    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer({ ...bonusVerdict, confidence: 0.3 }),
    });
    expect(outcome.applied).toBe(false);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(10);
  });

  it("追加触发评级突破：补发一次性酬金 + 称号（与结算突破同款留痕）", async () => {
    // F→E 需要总等级 5（累计 1200 XP）。垫到 1195，复核追加 5 → 正好跨过
    const settlementId = seedSettlement();
    db.update(character).set({ totalXp: 1195 }).where(eq(character.userId, userId)).run();
    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer(bonusVerdict),
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.notice).toContain("评级突破 F → E");

    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(1200);
    // F→E 晋升酬金 = 评级序数 2 × 200（原结算 gold 5 + 酬金 400）
    expect(c.gold).toBe(405);
    expect(db.select().from(titles).all().map((t) => t.titleKey)).toContain("rank_E");
  });

  describe("异议通道（当场复核）", () => {
    it("异议成立：disputes 置 upheld，叙事指令引导会长认错", async () => {
      const settlementId = seedSettlement();
      db.insert(disputes)
        .values({
          id: "d1",
          userId,
          settlementId,
          questId: "q1",
          claim: "这算意志不算体魄",
          status: "open",
          createdAt: Date.now(),
        })
        .run();

      const outcome = await runSettlementReview(db, userId, settlementId, {
        reviewer: fakeReviewer({
          no_adjustment: false,
          xp_bonus_ratio: 0,
          bonus_allocations: [],
          reclassification: { attr: "willpower", reason: "用户主张成立" },
          narrative_hint: "确实更偏意志",
          confidence: 0.9,
        }),
        disputeId: "d1",
      });

      // willpower 重分类被护栏拒绝（意志由代码独占）→ 无有效调整 → 维持原判
      expect(outcome.applied).toBe(false);
      const dispute = db.select().from(disputes).where(eq(disputes.id, "d1")).get()!;
      expect(dispute.status).toBe("rejected");
      expect(outcome.systemMessage).toContain("维持原判");
    });

    it("异议成立（合法重分类）：upheld + 属性修正", async () => {
      const settlementId = seedSettlement({ attrSplitJson: JSON.stringify({ creativity: 7, mind: 3 }) });
      db.update(quests)
        .set({ category: "创作交付", primaryAttr: "creativity", secondaryAttr: "mind" })
        .where(eq(quests.id, "q1"))
        .run();
      db.update(character)
        .set({ vitalityXp: 0, willpowerXp: 0, creativityXp: 7, mindXp: 3 })
        .where(eq(character.userId, userId))
        .run();
      db.insert(disputes)
        .values({
          id: "d2",
          userId,
          settlementId,
          questId: "q1",
          claim: "这算心智不算体魄",
          status: "open",
          createdAt: Date.now(),
        })
        .run();

      const outcome = await runSettlementReview(db, userId, settlementId, {
        reviewer: fakeReviewer({
          no_adjustment: false,
          xp_bonus_ratio: 0,
          bonus_allocations: [],
          reclassification: { attr: "mind", reason: "用户主张成立" },
          narrative_hint: "确实更偏心智",
          confidence: 0.9,
        }),
        disputeId: "d2",
      });

      expect(outcome.applied).toBe(true);
      const dispute = db.select().from(disputes).where(eq(disputes.id, "d2")).get()!;
      expect(dispute.status).toBe("upheld");
      expect(dispute.resolution).toContain("确实更偏心智");

      const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
      expect(c.totalXp).toBe(10);
      expect(c.creativityXp).toBe(0);
      expect(c.mindXp).toBe(10);
    });
  });
});

describe("复核管线 · fail-open 时的异议交代", () => {
  it("判定器失败 + 异议：disputes 当场按维持原判裁决，不悬 open", async () => {
    const settlementId = seedSettlement();
    db.insert(disputes)
      .values({
        id: "d-fail",
        userId,
        settlementId,
        questId: "q1",
        claim: "我不服",
        status: "open",
        createdAt: Date.now(),
      })
      .run();

    const outcome = await runSettlementReview(db, userId, settlementId, {
      reviewer: fakeReviewer(new Error("judge down")),
      disputeId: "d-fail",
    });

    expect(outcome.ran).toBe(false);
    expect(outcome.systemMessage).toContain("维持原判");
    const dispute = db.select().from(disputes).where(eq(disputes.id, "d-fail")).get()!;
    expect(dispute.status).toBe("rejected");
    expect(dispute.resolution).toContain("维持原判");
  });
});
