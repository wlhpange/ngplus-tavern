import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { quests, character, settlementLog, chatLog, disputes } from "../../src/server/db/schema";
import { runConversation } from "../../src/server/llm/conversation";
import { createBook, replaceBookEntries, assignBook } from "../../src/server/worldbook";
import { VILA_MASTER_ID } from "../../src/server/db/seed";
import {
  createTestDb,
  ScriptedModel,
  text,
  toolCall,
  toolResultOf,
} from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

describe("对话主循环（mock LLM，M2 验收第 3 条）", () => {
  it("「我想每天背单词」→ create_quest → 接受 → 「背完了，50 个」→ settle_completion → DB 对账", async () => {
    // ---- 第 1 轮：提出委托 ----
    const llm1 = new ScriptedModel([
      toolCall("c1", "create_quest", {
        title: "每天背单词",
        description: "每天背 50 个英语单词",
        type: "daily",
        category: "课程学习",
        primary_attr: "mind",
        primary_weight: 0.7,
        secondary_attr: "willpower",
        secondary_weight: 0.3,
        attr_reason: "背单词主要是认知活动，坚持每天也需要意志",
        difficulty: 1,
      }),
      text("哟，小冒险家，这事儿我接了——委托拟好了：每天背单词，你看一眼，接不接？"),
    ]);
    const r1 = await runConversation(db, userId, "我想每天背单词", { model: llm1.model, dailyRand: () => 1 });
    expect(r1.replyText).toContain("委托拟好了");
    expect(r1.stateChanged).toBe(true);

    const quest = db.select().from(quests).where(eq(quests.userId, userId)).get()!;
    expect(quest.status).toBe("proposed");
    expect(quest.primaryAttr).toBe("mind");

    // 系统提示词第一层注入了骨架铁律
    const systemPrompt = llm1.calls[0].system;
    expect(systemPrompt).toContain("你无权在文本中声明任何数值变更");

    // ---- 第 2 轮：接受委托 ----
    const llm2 = new ScriptedModel([
      toolCall("c2", "respond_to_quest", { quest_id: quest.id, action: "accept" }),
      text("好嘞，委托挂上告示板了。明天这个时候，我等你凯旋。"),
    ]);
    const r2 = await runConversation(db, userId, "好，我接受", { model: llm2.model, dailyRand: () => 1 });
    expect(r2.stateChanged).toBe(true);
    expect(db.select().from(quests).where(eq(quests.id, quest.id)).get()?.status).toBe("active");

    // ---- 第 3 轮：汇报完成 → 结算 ----
    const llm3 = new ScriptedModel([
      toolCall("c3", "settle_completion", {
        quest_id: quest.id,
        evidence: "用户汇报：背完了，50 个",
        completion_ratio: 1,
        confidence: 0.92,
      }),
      // 最终叙事：不含任何编造的数值声明
      text("好家伙，第一天就拿下了！我在你的卷宗上记了一笔——这样下去，你很快就不只是新面孔了。"),
    ]);
    const r3 = await runConversation(db, userId, "背完了，50 个", { model: llm3.model, dailyRand: () => 1 });

    // 回复为纯叙事文本（mock 文本本身不含数值声明）
    expect(r3.replyText).toContain("好家伙");
    expect(r3.replyText).not.toMatch(/\d+\s*(XP|金币)/);

    // 结算通知来自服务端 DB 状态而非 LLM 文本
    expect(r3.settlementNotices).toHaveLength(1);
    expect(r3.settlementNotices[0]).toContain("+10 XP"); // daily 基准10 × 难度1 × 连击1.0(streak=0)
    expect(r3.settlementNotices[0]).toContain("+5 金币");

    // ---- DB 对账 ----
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(5);
    expect(c.totalXp).toBeGreaterThan(0);

    const log = db.select().from(settlementLog)
      .where(and(eq(settlementLog.questId, quest.id), eq(settlementLog.kind, "quest_complete")))
      .get()!;
    expect(log.confidence).toBe(0.92);
    expect(log.llmReasoning).toContain("50 个");
    // 属性分流对账：split 合计 === xp_awarded === character.totalXp
    const split = JSON.parse(log.attrSplitJson) as Record<string, number>;
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(log.xpAwarded);
    expect(log.xpAwarded).toBe(c.totalXp);

    // daily 结算后 streak=1，任务保持 active
    const qAfter = db.select().from(quests).where(eq(quests.id, quest.id)).get()!;
    expect(qAfter.streak).toBe(1);
    expect(qAfter.status).toBe("active");

    // chat_log 落库：user/master/system 三种角色都有
    const roles = db.select().from(chatLog).all().map((r) => r.role);
    expect(roles).toContain("user");
    expect(roles).toContain("master");
    expect(roles).toContain("system");

    // 第 3 轮第一次 LLM 调用带上了历史消息（最近 20 轮机制）
    const histCall = llm3.calls[0];
    expect(histCall.messages.some((m) => m.text === "我想每天背单词")).toBe(true);
  });

  it("属性越界：打回一次后 LLM 重判成功", async () => {
    const llm = new ScriptedModel([
      // 第一次：wealth 对「课程学习」越界
      toolCall("c1", "create_quest", {
        title: "每天背单词", type: "daily", category: "课程学习",
        primary_attr: "wealth", attr_reason: "错误分配",
      }),
      // 打回后重判：改用 mind
      (call) => {
        const result = toolResultOf(call.messages, "create_quest");
        expect(result.retry).toBe(true);
        return toolCall("c2", "create_quest", {
          title: "每天背单词", type: "daily", category: "课程学习",
          primary_attr: "mind", attr_reason: "重判：背单词是认知活动",
        });
      },
      text("委托拟好了，这次属性归到心智。"),
    ]);
    const r = await runConversation(db, userId, "我想每天背单词", { model: llm.model, dailyRand: () => 1 });
    expect(r.replyText).toContain("委托拟好了");
    const q = db.select().from(quests).where(eq(quests.userId, userId)).get()!;
    expect(q.primaryAttr).toBe("mind");
    expect(q.status).toBe("proposed");
  });

  it("低置信度汇报：工具返回需追问，不写 settlement_log", async () => {
    db.insert(quests).values({
      id: "q_active", userId, title: "晨跑", type: "daily",
      primaryAttr: "vitality", difficulty: 1, status: "active", streak: 0,
      createdAt: Date.now(),
    }).run();
    const llm = new ScriptedModel([
      toolCall("c1", "settle_completion", {
        quest_id: "q_active", completion_ratio: 1, confidence: 0.3,
      }),
      text("跑完啦？跑了多久、跑了多远？说具体点，我好给你记上。"),
    ]);
    const r = await runConversation(db, userId, "我跑完了", { model: llm.model, dailyRand: () => 1 });
    expect(r.replyText).toContain("跑了多久");
    expect(db.select().from(settlementLog).all()).toHaveLength(0);
    expect(r.stateChanged).toBe(false);
  });

  it("LLM 不知道任务状态时应调 lookup_quests（结果来自 DB）", async () => {
    db.insert(quests).values({
      id: "q1", userId, title: "每天背单词", type: "daily",
      primaryAttr: "mind", difficulty: 1, status: "active", streak: 4,
      createdAt: Date.now(),
    }).run();
    const llm = new ScriptedModel([
      toolCall("c1", "lookup_quests", { status: "active" }),
      (call) => {
        const data = toolResultOf(call.messages, "lookup_quests") as {
          quests: { title: string; streak: number }[];
        };
        expect(data.quests[0].title).toBe("每天背单词");
        expect(data.quests[0].streak).toBe(4);
        return text("告示板上挂着「每天背单词」，你已经连了四天了，别断。");
      },
    ]);
    const r = await runConversation(db, userId, "我现在有哪些任务？", { model: llm.model, dailyRand: () => 1 });
    expect(r.replyText).toContain("每天背单词");
  });
});

// --------------------------------------- 复核管线挂钩（V1.5：结算复核 / 异议复核）

import type { ReviewVerdict } from "../../src/server/engine/review";
import type { SettlementReviewer } from "../../src/server/llm/reviewer";

const bonusVerdict: ReviewVerdict = {
  no_adjustment: false,
  xp_bonus_ratio: 0.5,
  bonus_allocations: [{ attr: "mind", share: 1, reason: "质量超预期" }],
  reclassification: null,
  narrative_hint: "计划外的战果也是战果",
  confidence: 0.92,
};

function fakeReviewer(verdict: ReviewVerdict | null): SettlementReviewer {
  return { review: async () => verdict };
}

function seedActiveQuest() {
  db.insert(quests).values({
    id: "q_hook", userId, title: "每天背单词", type: "daily",
    category: "课程学习",
    primaryAttr: "mind", primaryWeight: 1.0, difficulty: 1,
    status: "active", streak: 0, createdAt: Date.now(),
  }).run();
}

describe("对话 × 复核管线（V1.5）", () => {
  it("结算成功 → 收获复核挂钩：提示条追加复核通知，角色 XP 含追加部分", async () => {
    seedActiveQuest();
    const llm = new ScriptedModel([
      toolCall("c1", "settle_completion", {
        quest_id: "q_hook", completion_ratio: 1, confidence: 0.95,
        evidence: "背完了 50 个",
      }),
      text("记上了。明天同一时间。"),
    ]);
    const r = await runConversation(db, userId, "背完了，50 个", {
      model: llm.model, dailyRand: () => 1,
      reviewer: fakeReviewer(bonusVerdict),
    });

    // 工具通知 + 复核通知都进提示条（数据全部来自 DB/引擎）
    expect(r.settlementNotices.some((n) => n.startsWith("结算「"))).toBe(true);
    expect(r.settlementNotices.some((n) => n.includes("收获复核"))).toBe(true);
    expect(r.stateChanged).toBe(true);

    // 原结算 10 XP + 复核追加 5 XP（当日软上限内）
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(15);
    expect(
      db.select().from(settlementLog).where(eq(settlementLog.kind, "review_adjustment")).all(),
    ).toHaveLength(1);
  });

  it("复核未启用（reviewer=null）：行为与 V1 完全一致", async () => {
    seedActiveQuest();
    const llm = new ScriptedModel([
      toolCall("c1", "settle_completion", {
        quest_id: "q_hook", completion_ratio: 1, confidence: 0.95,
      }),
      text("记上了。"),
    ]);
    const r = await runConversation(db, userId, "背完了", {
      model: llm.model, dailyRand: () => 1,
      reviewer: null,
    });
    expect(r.settlementNotices).toHaveLength(1); // 只有工具结算通知
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(10);
    expect(
      db.select().from(settlementLog).where(eq(settlementLog.kind, "review_adjustment")).all(),
    ).toHaveLength(0);
  });

  it("异议流程：file_dispute → 当场复核 → 会长得带叙事指令的最终回复", async () => {
    seedActiveQuest();
    // 先造一笔历史结算（异议的对象）
    db.insert(settlementLog).values({
      id: "s_old", userId, questId: "q_hook", kind: "quest_complete",
      completionRatio: 1, confidence: 0.9, xpAwarded: 10, goldAwarded: 5,
      attrSplitJson: JSON.stringify({ mind: 10 }),
      llmReasoning: "背完了 50 个",
      createdAt: Date.now(),
    }).run();

    const llm = new ScriptedModel([
      toolCall("c1", "file_dispute", {
        quest_id: "q_hook", claim: "这算意志不算心智",
      }),
      // 复核结论通过 system 注入后的最终叙事（mock 直接给文本）
      text("行，我去把卷宗翻出来再核一遍。"),
    ]);
    const r = await runConversation(db, userId, "这明明算意志，不算心智", {
      model: llm.model, dailyRand: () => 1,
      // 独自运动之外：课程学习 [mind, willpower]，willpower 被独占规则拒绝
      // → 重分类无效 → 维持原判，但 disputes 行会被裁决为 rejected
      reviewer: fakeReviewer({
        no_adjustment: false,
        xp_bonus_ratio: 0,
        bonus_allocations: [],
        reclassification: { attr: "willpower", reason: "用户主张成立" },
        narrative_hint: "维持原判",
        confidence: 0.9,
      }),
    });

    expect(r.replyText).toContain("卷宗");
    const dispute = db.select().from(disputes).all().at(-1)!;
    expect(dispute.status).toBe("rejected"); // willpower 重分类被护栏拒绝
    expect(dispute.resolution).toContain("复核未产生有效调整");
  });
});

// -------------------------- V1.7 完整性加固：漏发对账提醒 / 记忆复核

import { memory } from "../../src/server/db/schema";
import type { MemoryReviewer as MemReviewer } from "../../src/server/llm/reviewer";

const nullReviewer: SettlementReviewer = { review: async () => null };
const nullMemReviewer: MemReviewer = { review: async () => null };

function seedActiveDaily() {
  db.insert(quests).values({
    id: "q_nudge", userId, title: "每天背单词", type: "daily",
    category: "课程学习", primaryAttr: "mind", difficulty: 1,
    status: "active", streak: 0, createdAt: Date.now(),
  }).run();
}

describe("漏发对账提醒（V1.7）", () => {
  it("汇报话术 + 会长没调结算 → 注入提醒触发补账回合", async () => {
    seedActiveDaily();
    const llm = new ScriptedModel([
      text("哟，行啊。"), // 第一轮：嘴上回应，没调工具（漏发现场）
      toolCall("n1", "settle_completion", {
        quest_id: "q_nudge", completion_ratio: 1.2, confidence: 0.92,
      }),
      text("补上了。明天继续。"),
    ]);
    const r = await runConversation(db, userId, "背单词交差了，超额 20%", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });

    expect(r.replyText).toContain("补上了");
    expect(r.toolSummaries.some((t) => t.name === "settle_completion")).toBe(true);
    expect(db.select().from(settlementLog).where(eq(settlementLog.kind, "quest_complete")).all()).toHaveLength(1);
    // 用户可见的对账提示不出现（因为补上了）
    expect(r.settlementNotices.some((n) => n.includes("没记上"))).toBe(false);
  });

  it("会长坚持不记 → 给用户一条可见的对账提示", async () => {
    seedActiveDaily();
    const llm = new ScriptedModel([
      text("嗯，知道了。"), // 漏发
      text("真没什么好记的。"), // 提醒后仍不记（确非汇报/坚持判断）
    ]);
    const r = await runConversation(db, userId, "今天跑步交差了", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.reminderNotices.some((n) => n.includes("没记上"))).toBe(true);
    expect(db.select().from(settlementLog).all()).toHaveLength(0);
  });

  it("闲聊与追问不触发提醒（无多余 LLM 调用）", async () => {
    seedActiveDaily();
    // 若触发提醒，脚本会被多调一次而抛"脚本已耗尽"——不抛即通过
    const llm1 = new ScriptedModel([text("哟，坐。")]);
    await runConversation(db, userId, "你好呀", { model: llm1.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: nullMemReviewer });
    const llm2 = new ScriptedModel([text("跑完了吗？说个数。")]);
    await runConversation(db, userId, "今天跑步交差了？我忘了", { model: llm2.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: nullMemReviewer });
  });
});

describe("记忆复核（V1.7）", () => {
  it("复核修正：记忆内容被替换为修正稿", async () => {
    const llm = new ScriptedModel([
      toolCall("m1", "add_memory", { category: "goal", content: "用户说他喜欢熬夜打游戏" }),
      text("记下了。"),
    ]);
    const memReviewer: MemReviewer = {
      review: async () => ({ action: "correct", content: "想调整作息，减少熬夜打游戏", reason: "上下文是戒熬夜，原句记反了" }),
    };
    await runConversation(db, userId, "我要戒掉熬夜打游戏", {
      model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: memReviewer,
    });
    const rows = db.select().from(memory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("想调整作息，减少熬夜打游戏");
  });

  it("复核驳回：记忆被删除，会长收到不要再提的指令", async () => {
    const llm = new ScriptedModel([
      toolCall("m2", "add_memory", { category: "profile", content: "用户是外星人" }),
      text("嗯。"),
    ]);
    const memReviewer: MemReviewer = {
      review: async () => ({ action: "discard", reason: "上下文没有任何依据" }),
    };
    await runConversation(db, userId, "随便聊聊今天天气", {
      model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: memReviewer,
    });
    expect(db.select().from(memory).all()).toHaveLength(0);
  });

  it("复核失败 fail-open：记忆照原样保留", async () => {
    const llm = new ScriptedModel([
      toolCall("m3", "add_memory", { category: "preference", content: "用户喜欢清晨跑步" }),
      text("好。"),
    ]);
    const memReviewer: MemReviewer = {
      review: async () => { throw new Error("judge down"); },
    };
    await runConversation(db, userId, "我喜欢清晨跑步", {
      model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: memReviewer,
    });
    const rows = db.select().from(memory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("用户喜欢清晨跑步");
  });
});

// --------------------------------------- V1.8 每日签到（引擎自动结算）

describe("每日签到（V1.8）", () => {
  it("当日首条消息 → 引擎自动结算签到委托，会长开场被注入提醒", async () => {
    db.insert(quests).values({
      id: "q_checkin", userId, title: "每天来协会打卡", type: "daily",
      checkin: 1, category: "社交活动", primaryAttr: "social",
      difficulty: 1, status: "active", streak: 0, createdAt: Date.now(),
    }).run();
    const llm = new ScriptedModel([text("哟，来了。签到章给你盖了。")]);
    const r = await runConversation(db, userId, "我来了", {
      model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: nullMemReviewer,
    });

    expect(r.settlementNotices.some((n) => n.startsWith("签到「"))).toBe(true);
    const log = db.select().from(settlementLog).where(eq(settlementLog.kind, "quest_complete")).all().at(-1)!;
    expect(log.llmReasoning).toContain("每日签到");
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(4);
    expect(c.gold).toBe(2);
    expect(c.socialXp).toBe(4);
    const q = db.select().from(quests).where(eq(quests.id, "q_checkin")).get()!;
    expect(q.streak).toBe(1);
  });

  it("同日第二条消息不重复签到", async () => {
    db.insert(quests).values({
      id: "q_checkin", userId, title: "每天来协会打卡", type: "daily",
      checkin: 1, category: "社交活动", primaryAttr: "social",
      difficulty: 1, status: "active", streak: 1, createdAt: Date.now(),
    }).run();
    const llm = new ScriptedModel([text("哟。"), text("嗯。")]);
    await runConversation(db, userId, "我又来了", { model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: nullMemReviewer });
    await runConversation(db, userId, "没事，就是来看看", { model: llm.model, dailyRand: () => 1, reviewer: nullReviewer, memoryReviewer: nullMemReviewer });
    const logs = db.select().from(settlementLog).where(eq(settlementLog.kind, "quest_complete")).all();
    expect(logs).toHaveLength(1);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(4);
  });
});

describe("结算卡片流（V2.0，result.settlements）", () => {
  it("结算轮：返回本轮落账记录（quest_complete 带任务标题与数值）", async () => {
    seedActiveDaily();
    const llm = new ScriptedModel([
      toolCall("s1", "settle_completion", {
        quest_id: "q_nudge", completion_ratio: 1, confidence: 0.9, evidence: "背完了 50 个",
      }),
      text("记上了。"),
    ]);
    const r = await runConversation(db, userId, "单词背完了", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    const card = r.settlements.find((s) => s.kind === "quest_complete");
    expect(card).toBeDefined();
    expect(card?.questTitle).toBe("每天背单词");
    expect(card?.xpAwarded).toBeGreaterThan(0);
    expect(card?.goldAwarded).toBeGreaterThan(0);
    // 提示条只会有成就解锁这类通知（夜间跑测试可能触发「夜航」），不会有对账提醒
    expect(r.reminderNotices.every((n) => n.includes("成就解锁"))).toBe(true);
  });

  it("纯闲聊轮：settlements 为空、无提示", async () => {
    const llm = new ScriptedModel([text("哟，坐吧。")]);
    const r = await runConversation(db, userId, "今天天气不错", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.settlements).toEqual([]);
    expect(r.reminderNotices).toEqual([]);
  });
});

describe("成就播报（V3）", () => {
  it("轮开始评估：条件已满足的成就当场发放，并注入叙事指令 + 提示条", async () => {
    // 先造出「第一份战果」的条件（已有一件完成委托）
    db.insert(quests).values({
      id: "q_ach", userId, title: "已经完成过的事", type: "once",
      primaryAttr: "mind", status: "completed", completedAt: Date.now(), createdAt: Date.now(),
    }).run();

    const llm = new ScriptedModel([text("哟，坐。")]);
    const r = await runConversation(db, userId, "你好呀", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.reminderNotices.some((n) => n.includes("成就解锁"))).toBe(true);
    expect(llm.calls[0].system).toContain("【成就】");
    // 成就进流水（时间线可见）
    expect(
      db.select().from(settlementLog).all().some((l) => l.kind === "achievement"),
    ).toBe(true);
  });
});

describe("周常 Boss 播报（V3）", () => {
  it("条件已达标：轮开始即发奖，注入叙事指令 + 提示条", async () => {
    const now = Date.now();
    // 塞满所有周常指标（pickWeeklyBoss 与当前周绑定，指标未知）
    db.insert(quests).values({
      id: "q_wb_checkin", userId, title: "签到", type: "daily",
      primaryAttr: "mind", status: "active", checkin: 1, createdAt: now,
    }).run();
    for (let i = 0; i < 5; i++) {
      db.insert(settlementLog).values({
        id: `wb_s${i}`, userId, questId: i < 3 ? "q_wb_checkin" : null,
        kind: "quest_complete", xpAwarded: 80, goldAwarded: 5,
        attrSplitJson: "{}", createdAt: now + i,
      }).run();
    }

    const llm = new ScriptedModel([text("哟，坐。")]);
    const r = await runConversation(db, userId, "晚上好", {
      model: llm.model, dailyRand: () => 1,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.reminderNotices.some((n) => n.includes("周常讨伐"))).toBe(true);
    expect(llm.calls[0].system).toContain("【周常讨伐】");
    expect(
      db.select().from(settlementLog).all().some((l) => l.kind === "weekly_boss"),
    ).toBe(true);
  });
});

describe("每日事件播报（V3）", () => {
  it("当天首次对话命中事件：注入叙事指令 + 提示条", async () => {
    const llm = new ScriptedModel([text("哟，坐。")]);
    const r = await runConversation(db, userId, "早", {
      model: llm.model,
      dailyRand: () => 0, // 命中概率 + 取第 1 个事件（旅商）
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.reminderNotices.some((n) => n.includes("今日事件"))).toBe(true);
    expect(llm.calls[0].system).toContain("【每日事件】");
  });

  it("未命中：无事件播报", async () => {
    const llm = new ScriptedModel([text("哟，坐。")]);
    const r = await runConversation(db, userId, "早", {
      model: llm.model,
      dailyRand: () => 0.99,
      reviewer: nullReviewer,
      memoryReviewer: nullMemReviewer,
    });
    expect(r.reminderNotices.some((n) => n.includes("今日事件"))).toBe(false);
  });
});

describe("任务模式不注入世界书（世界书只属于聊天/RP）", () => {
  it("当前会长挂载书册的常驻条目不进任务系统提示词", async () => {
    const book = createBook(db, userId, "协会设定");
    replaceBookEntries(db, userId, book, [
      { keys: [], content: "协会坐落在旧钟楼。", constant: true },
      { keys: [], content: "薇拉的抽屉里有一封没寄出的信。", constant: true },
    ]);
    assignBook(db, userId, VILA_MASTER_ID, book);

    const llm = new ScriptedModel([text("哟，坐。")]);
    await runConversation(db, userId, "你好", {
      model: llm.model,
      dailyRand: () => 0.99,
      reviewer: null,
      memoryReviewer: null,
    });
    const system = llm.calls[0].system;
    // 世界书（含常驻条目）不得出现在任务线提示词里——任务线只用角色卡本身设定
    expect(system).not.toContain("协会坐落在旧钟楼。");
    expect(system).not.toContain("薇拉的抽屉里有一封没寄出的信。");
    // 骨架铁律仍在（世界书下线不影响任务线本身）
    expect(system).toContain("你无权在文本中声明任何数值变更");
  });
});
