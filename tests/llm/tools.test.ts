import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { quests, character, settlementLog, memory, users, disputes, items } from "../../src/server/db/schema";
import { executeTool, createToolContext, TOOL_DEFINITIONS } from "../../src/server/llm/tools";
import { settleQuest } from "../../src/server/engine/settlement";
import { createTestDb } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function makeQuest(overrides: Partial<typeof quests.$inferInsert> = {}) {
  const id = overrides.id ?? `q_${Math.random().toString(36).slice(2, 8)}`;
  db.insert(quests)
    .values({
      id,
      userId,
      title: "测试任务",
      type: "daily",
      primaryAttr: "mind",
      primaryWeight: 1.0,
      difficulty: 1,
      status: "active",
      streak: 0,
      createdAt: Date.now(),
      ...overrides,
    })
    .run();
  return id;
}

describe("工具定义", () => {
  it("九个工具齐备，create_quest 含 category 参数（§8 白名单前置）", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toEqual([
      "create_quest",
      "respond_to_quest",
      "lookup_quests",
      "settle_completion",
      "query_character",
      "add_memory",
      "buy_item", // V1.5：金币消耗口（休整卷轴/礼物）
      "gift_item", // V2.0：礼物赠送（消耗一份 + 亲密度推进）
      "file_dispute", // V1.5：异议通道（双入口收束同一条复核管线）
    ]);
    const cq = TOOL_DEFINITIONS[0].function.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(cq.required).toContain("category");
  });
});

describe("create_quest · 属性白名单校验（§8）", () => {
  const baseArgs = {
    title: "每天背单词",
    type: "daily",
    category: "课程学习",
    primary_attr: "mind",
    attr_reason: "背单词是认知活动",
  };

  it("合法分配：创建 proposed 草稿", () => {
    const r = executeTool(db, userId, "create_quest", JSON.stringify(baseArgs), createToolContext());
    expect(r.ok).toBe(true);
    const row = db.select().from(quests).where(eq(quests.userId, userId)).get();
    expect(row?.status).toBe("proposed");
    expect(row?.primaryAttr).toBe("mind");
  });

  it("越界第一次：打回要求重判，不落库", () => {
    const ctx = createToolContext();
    const r = executeTool(
      db, userId, "create_quest",
      JSON.stringify({ ...baseArgs, primary_attr: "wealth" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect((r.data as { retry?: boolean }).retry).toBe(true);
    expect(r.summary).toContain("越界");
    expect(db.select().from(quests).all()).toHaveLength(0);
    expect(ctx.attrRejections).toBe(1);
  });

  it("越界第二次：兜底取类别第一个允许属性，attr_reason 保留原始理由（技术话术不进界面）", () => {
    const ctx = createToolContext();
    const args = JSON.stringify({ ...baseArgs, primary_attr: "wealth" });
    executeTool(db, userId, "create_quest", args, ctx); // 第一次打回
    const r2 = executeTool(db, userId, "create_quest", args, ctx); // 第二次仍越界
    expect(r2.ok).toBe(true);
    const row = db.select().from(quests).where(eq(quests.userId, userId)).get();
    expect(row?.primaryAttr).toBe("mind"); // 课程学习白名单第一个
    expect(row?.attrReason).toBe("背单词是认知活动");
    expect(row?.attrReason).not.toContain("兜底修正");
  });

  it("mainline_milestone 缺 parent_quest_id 拒绝；parent 不存在也拒绝", () => {
    const ctx = createToolContext();
    const r1 = executeTool(
      db, userId, "create_quest",
      JSON.stringify({ ...baseArgs, type: "mainline_milestone" }),
      ctx,
    );
    expect(r1.ok).toBe(false);
    expect(r1.summary).toContain("parent_quest_id");

    const r2 = executeTool(
      db, userId, "create_quest",
      JSON.stringify({ ...baseArgs, type: "mainline_milestone", parent_quest_id: "ghost" }),
      ctx,
    );
    expect(r2.ok).toBe(false);
    expect(r2.summary).toContain("找不到主线任务");
  });

  it("权重越界拒绝", () => {
    const r = executeTool(
      db, userId, "create_quest",
      JSON.stringify({ ...baseArgs, primary_weight: 0.3 }),
      createToolContext(),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("primary_weight");
  });
});

describe("respond_to_quest", () => {
  it("accept → active；reject → rejected；非 proposed 不可操作", () => {
    const id = makeQuest({ status: "proposed" });
    const r = executeTool(db, userId, "respond_to_quest",
      JSON.stringify({ quest_id: id, action: "accept" }), createToolContext());
    expect(r.ok).toBe(true);
    expect(db.select().from(quests).where(eq(quests.id, id)).get()?.status).toBe("active");

    const r2 = executeTool(db, userId, "respond_to_quest",
      JSON.stringify({ quest_id: id, action: "reject" }), createToolContext());
    expect(r2.ok).toBe(false); // 已 active，不能再 reject
  });
});

describe("settle_completion · 服务端校验", () => {
  it("任务非 active 拒绝结算", () => {
    const id = makeQuest({ status: "proposed" });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9 }),
      createToolContext());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("进行中");
  });

  it("confidence<0.5 拒绝结算并提示需追问，不写 settlement_log", () => {
    const id = makeQuest();
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.4 }),
      createToolContext());
    expect(r.ok).toBe(false);
    expect((r.data as { need_follow_up?: boolean }).need_follow_up).toBe(true);
    expect(r.summary).toContain("追问");
    expect(db.select().from(settlementLog).all()).toHaveLength(0);
  });

  it("daily 同日重复结算拒绝", () => {
    const id = makeQuest({ type: "daily" });
    const args = JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9, evidence: "背了 50 个" });
    const r1 = executeTool(db, userId, "settle_completion", args, createToolContext());
    expect(r1.ok).toBe(true);
    const r2 = executeTool(db, userId, "settle_completion", args, createToolContext());
    expect(r2.ok).toBe(false);
    expect(r2.summary).toContain("今日已结算");
  });
});

describe("settle_completion · 正常结算与对账", () => {
  it("daily 结算：XP/属性/金币入库正确，streak+1，settlement_log 可对账", () => {
    const id = makeQuest({ type: "daily", primaryAttr: "mind", streak: 2 });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9, evidence: "背完 50 个单词" }),
      createToolContext());
    expect(r.ok).toBe(true);

    // 引擎独立重算期望值：daily 基准 10 × 难度1 × 连击(1+0.05*2=1.1) = 11
    const expected = settleQuest({
      type: "daily", difficulty: 1, streak: 2, completionRatio: 1,
      primaryAttr: "mind", todaySettledXp: 0,
    });
    expect(expected.xpAwarded).toBe(11);

    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.totalXp).toBe(expected.xpAwarded);
    expect(c.gold).toBe(expected.goldAwarded); // 金币不吃连击：5
    expect(c.mindXp).toBe(expected.attrSplit.mind ?? 0);
    expect(c.willpowerXp).toBe(expected.attrSplit.willpower ?? 0);

    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.streak).toBe(3); // 2 + 1
    expect(q.status).toBe("active"); // daily 保持进行中

    const logs = db.select().from(settlementLog)
      .where(eq(settlementLog.questId, id)).all();
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.kind).toBe("quest_complete");
    expect(log.confidence).toBe(0.9);
    expect(log.completionRatio).toBe(1);
    expect(log.xpAwarded).toBe(expected.xpAwarded);
    expect(log.goldAwarded).toBe(expected.goldAwarded);
    expect(log.llmReasoning).toBe("背完 50 个单词");
    // attr_split 合计 === xp_awarded（对账一致）
    const split = JSON.parse(log.attrSplitJson) as Record<string, number>;
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(log.xpAwarded);
  });

  it("once 结算后置 completed；部分完成 completion_ratio<1 按比例折算", () => {
    const id = makeQuest({ type: "once" });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 0.5, confidence: 0.9 }),
      createToolContext());
    expect(r.ok).toBe(true);
    const data = r.data as { xp_awarded: number };
    expect(data.xp_awarded).toBe(13); // 25 × 0.5 = 12.5 → 13
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.status).toBe("completed");
    expect(q.completedAt).not.toBeNull();
  });

  it("升级检测：跨越等级阈值时返回 level_ups", () => {
    db.update(character).set({ totalXp: 145, mindXp: 145 })
      .where(eq(character.userId, userId)).run();
    const id = makeQuest({ type: "once", primaryAttr: "mind" }); // +25 XP → 170，Lv1→2
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9 }),
      createToolContext());
    expect(r.ok).toBe(true);
    const data = r.data as { level_ups: { scope: string; from: number; to: number }[] };
    expect(data.level_ups).toContainEqual({ scope: "total", from: 1, to: 2 });
    expect(data.level_ups).toContainEqual({ scope: "mind", from: 1, to: 2 });
  });

  it("评级突破：发一次性酬金 + 突破礼（休整卷轴）+ 称号，并留痕 title_grant", () => {
    // 距 Lv.5（评级 E）差 5 XP；once 结算 +25 → 突破
    db.update(character).set({ totalXp: 1195 })
      .where(eq(character.userId, userId)).run();
    const id = makeQuest({ type: "once" });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.95 }),
      createToolContext(() => 0.9));
    expect(r.ok).toBe(true);
    const data = r.data as {
      rank_up: {
        from: string;
        to: string;
        gold: number;
        items: { name: string; count: number }[];
      };
    };
    expect(data.rank_up).toMatchObject({ from: "F", to: "E", gold: 400 }); // 序数2 × 200
    expect(data.rank_up.items).toEqual([{ name: "休整卷轴", count: 1 }]);

    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(10 + 400); // 任务金币 + 突破酬金

    // 突破礼已入袋
    const stock = db
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.itemKey, "rest_scroll")))
      .get();
    expect(stock?.count).toBe(1);

    const kinds = db.select().from(settlementLog).all().map((l) => l.kind);
    expect(kinds).toContain("quest_complete");
    expect(kinds).toContain("title_grant");
  });
});

describe("lookup_quests / query_character / add_memory", () => {
  it("lookup_quests 按状态过滤", () => {
    makeQuest({ status: "active", title: "A" });
    makeQuest({ status: "proposed", title: "B" });
    const r = executeTool(db, userId, "lookup_quests",
      JSON.stringify({ status: "active" }), createToolContext());
    const data = r.data as { quests: { title: string }[]; count: number };
    expect(data.count).toBe(1);
    expect(data.quests[0].title).toBe("A");
  });

  it("query_character 返回等级/评级/金币/称号", () => {
    const r = executeTool(db, userId, "query_character", "{}", createToolContext());
    const data = r.data as { totalLevel: number; rank: string; gold: number; attrs: Record<string, unknown> };
    expect(data.totalLevel).toBe(1);
    expect(data.rank).toBe("F");
    expect(Object.keys(data.attrs)).toHaveLength(6);
  });

  it("add_memory 写入 memory 表", () => {
    const r = executeTool(db, userId, "add_memory",
      JSON.stringify({ category: "goal", content: "今年背完 3000 单词" }),
      createToolContext());
    expect(r.ok).toBe(true);
    const rows = db.select().from(memory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("goal");
  });
});

describe("settle_completion · 逾期任务补结算（M5 断签恢复）", () => {
  it("overdue 任务可补结算：拉回 active、break_streak 归零、streak 保留", () => {
    const id = makeQuest({ status: "overdue", streak: 4, breakStreak: 1 });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9 }),
      createToolContext());
    expect(r.ok).toBe(true);
    const q = db.select().from(quests).where(eq(quests.id, id)).get()!;
    expect(q.status).toBe("active");
    expect(q.breakStreak).toBe(0);
    // streak 沿用断签后的数值（4，加成已减半），结算后 +1
    expect(q.streak).toBe(5);
    expect(q.lastCheckedAt).not.toBeNull();
  });

  it("abandoned/completed 等非活跃状态仍拒绝结算", () => {
    const id = makeQuest({ status: "abandoned" });
    const r = executeTool(db, userId, "settle_completion",
      JSON.stringify({ quest_id: id, completion_ratio: 1, confidence: 0.9 }),
      createToolContext());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("进行中");
  });
});

// ---------------------------------------------- buy_item / file_dispute（V1.5）

describe("buy_item · 协会商店", () => {
  it("金币足够：购买成功、扣款、道具入袋", () => {
    db.update(character).set({ gold: 150 }).where(eq(character.userId, userId)).run();
    const r = executeTool(db, userId, "buy_item", JSON.stringify({ item_key: "rest_scroll" }), createToolContext());
    expect(r.ok).toBe(true);
    expect(r.stateChanged).toBe(true);
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(50);
  });

  it("金币不足：拒绝并报差额", () => {
    db.update(character).set({ gold: 30 }).where(eq(character.userId, userId)).run();
    const r = executeTool(db, userId, "buy_item", JSON.stringify({ item_key: "rest_scroll" }), createToolContext());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("金币不够");
  });

  it("未知商品：拒绝", () => {
    const r = executeTool(db, userId, "buy_item", JSON.stringify({ item_key: "phoenix_feather" }), createToolContext());
    expect(r.ok).toBe(false);
  });
});

describe("gift_item · 礼物赠送（V2.0）", () => {
  function stock(key: string, count: number) {
    db.insert(items).values({ id: `it_${key}`, userId, itemKey: key, count }).run();
  }

  it("有存货：消耗一份、返回交情信息、stateChanged", () => {
    stock("gift_tea", 1);
    const r = executeTool(db, userId, "gift_item", JSON.stringify({ item_key: "gift_tea" }), createToolContext());
    expect(r.ok).toBe(true);
    expect(r.stateChanged).toBe(true);
    const data = r.data as { count_left: number; intimacy_stage: number; stage_up: boolean };
    expect(data.count_left).toBe(0);
    expect(data.intimacy_stage).toBe(1);
    expect(data.stage_up).toBe(false);
  });

  it("无存货：拒绝并提示先买", () => {
    const r = executeTool(db, userId, "gift_item", JSON.stringify({ item_key: "gift_tea" }), createToolContext());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("抽屉里没有");
  });

  it("query_character 返回抽屉里的礼物存货（held_gifts）", () => {
    stock("gift_tea", 2);
    stock("gift_book", 1);
    const r = executeTool(db, userId, "query_character", "{}", createToolContext());
    const data = r.data as { held_gifts: { item_key: string; count: number }[] };
    expect(data.held_gifts).toEqual(
      expect.arrayContaining([
        { item_key: "gift_tea", count: 2 },
        { item_key: "gift_book", count: 1 },
      ]),
    );
  });
});

describe("file_dispute · 异议通道", () => {
  it("无结算记录的委托：无从异议", () => {
    db.insert(quests).values({
      id: "q_open", userId, title: "晨跑", type: "daily",
      primaryAttr: "vitality", difficulty: 1, status: "active", streak: 0,
      createdAt: Date.now(),
    }).run();
    const r = executeTool(db, userId, "file_dispute", JSON.stringify({ quest_id: "q_open", claim: "这算意志不算体魄" }), createToolContext());
    expect(r.ok).toBe(false);
  });

  it("已有结算：登记 open 异议，返回 dispute_id 与 settlement_id", () => {
    db.insert(quests).values({
      id: "q_done", userId, title: "晨跑", type: "daily",
      primaryAttr: "vitality", difficulty: 1, status: "active", streak: 1,
      createdAt: Date.now(),
    }).run();
    db.insert(settlementLog).values({
      id: "s_1", userId, questId: "q_done", kind: "quest_complete",
      completionRatio: 1, confidence: 0.9, xpAwarded: 10, goldAwarded: 5,
      attrSplitJson: "{}", llmReasoning: "跑了三公里", createdAt: Date.now(),
    }).run();

    const r = executeTool(db, userId, "file_dispute", JSON.stringify({ quest_id: "q_done", claim: "这算意志不算体魄" }), createToolContext());
    expect(r.ok).toBe(true);
    const data = r.data as { dispute_id: string; settlement_id: string; quest_title: string };
    expect(data.settlement_id).toBe("s_1");
    expect(data.quest_title).toBe("晨跑");

    const dispute = db.select().from(disputes).where(eq(disputes.id, data.dispute_id)).get()!;
    expect(dispute.status).toBe("open");
    expect(dispute.claim).toBe("这算意志不算体魄");
  });

  it("异议主张为空：拒绝", () => {
    const r = executeTool(db, userId, "file_dispute", JSON.stringify({ quest_id: "q_x", claim: "  " }), createToolContext());
    expect(r.ok).toBe(false);
  });
});


// ---------------------------------------- V1.8 签到参数 / 稀有奖励

describe("create_quest · 签到标志（V1.8）", () => {
  it("daily + checkin=true：落库 checkin=1，摘要带签到", () => {
    const r = executeTool(db, userId, "create_quest", JSON.stringify({
      title: "每天来协会打卡", type: "daily", category: "社交活动",
      primary_attr: "social", attr_reason: "到场即社交", checkin: true,
    }), createToolContext());
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("签到");
    const q = db.select().from(quests).where(eq(quests.userId, userId)).all().at(-1)!;
    expect(q.checkin).toBe(1);
    expect(q.type).toBe("daily");
  });

  it("非 daily 拒绝签到标志", () => {
    const r = executeTool(db, userId, "create_quest", JSON.stringify({
      title: "一次性大扫除", type: "once", category: "课程学习",
      primary_attr: "mind", attr_reason: "x", checkin: true,
    }), createToolContext());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("只能是每日类型");
  });
});

describe("settle_completion · 稀有奖励掷骰（V1.8）", () => {
  function makeOnceQuest() {
    db.insert(quests).values({
      id: "q_rare", userId, title: "写一篇演讲稿", type: "once",
      category: "创作交付", primaryAttr: "creativity", difficulty: 1,
      status: "active", streak: 0, createdAt: Date.now(),
    }).run();
    db.insert(character).values({ userId, totalXp: 0, gold: 0 }).onConflictDoNothing().run();
  }

  it("传说档：金币 ×3，留痕记录稀有度，XP 不变", () => {
    makeOnceQuest();
    const ctx = createToolContext(() => 0.01); // < 0.05 → legendary
    const r = executeTool(db, userId, "settle_completion", JSON.stringify({
      quest_id: "q_rare", completion_ratio: 1, confidence: 0.9,
    }), ctx);
    expect(r.ok).toBe(true);
    const rareData = r.data as { rarity: string; gold_awarded: number };
    expect(rareData.rarity).toBe("legendary");
    expect(rareData.gold_awarded).toBe(30); // once 基准 10 × 难度 1 × 3
    const log = db.select().from(settlementLog).where(eq(settlementLog.questId, "q_rare")).all().at(-1)!;
    expect(JSON.parse(log.adjustmentsJson!)).toMatchObject({ rarity: "legendary" });
    expect(log.xpAwarded).toBe(25); // XP 不受掷骰影响
  });

  it("普通档：无加成、adjustments_json 为 null", () => {
    makeOnceQuest();
    const ctx = createToolContext(() => 0.9); // ≥ 0.30 → common
    const r = executeTool(db, userId, "settle_completion", JSON.stringify({
      quest_id: "q_rare", completion_ratio: 1, confidence: 0.9,
    }), ctx);
    const commonData = r.data as { rarity: string; gold_awarded: number };
    expect(commonData.rarity).toBe("common");
    expect(commonData.gold_awarded).toBe(10);
    const log = db.select().from(settlementLog).where(eq(settlementLog.questId, "q_rare")).all().at(-1)!;
    expect(log.adjustmentsJson).toBeNull();
  });
});


// ---------------------------------------- V2.0 主线拆解

describe("create_quest · 主线与里程碑（V2.0）", () => {
  function createMainline(overrides: Record<string, unknown> = {}) {
    return executeTool(
      db, userId, "create_quest",
      JSON.stringify({
        title: "跑完一次半马", type: "mainline", category: "独自运动",
        primary_attr: "vitality", attr_reason: "耐力大目标", ...overrides,
      }),
      createToolContext(),
    );
  }

  it("主线不挂父任务；返回 proposed 草稿", () => {
    const r = createMainline();
    expect(r.ok).toBe(true);
    const row = db.select().from(quests).where(eq(quests.type, "mainline")).get()!;
    expect(row.status).toBe("proposed");
    expect(row.parentQuestId).toBeNull();
  });

  it("里程碑：父任务必须是主线，且数量有上限", () => {
    const parent = db.select().from(quests).where(eq(quests.type, "mainline")).get();
    expect(parent).toBeUndefined();
    createMainline();
    const main = db.select().from(quests).where(eq(quests.type, "mainline")).get()!;

    // 普通任务不能当父任务
    const normalId = makeQuest({ type: "once", status: "proposed" });
    const bad = executeTool(
      db, userId, "create_quest",
      JSON.stringify({
        title: "子任务", type: "mainline_milestone", category: "独自运动",
        primary_attr: "vitality", attr_reason: "x", parent_quest_id: normalId,
      }),
      createToolContext(),
    );
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain("不是主线");

    // 拆满上限后拒绝
    for (let i = 0; i < 6; i++) {
      const r = executeTool(
        db, userId, "create_quest",
        JSON.stringify({
          title: `里程碑 ${i}`, type: "mainline_milestone", category: "独自运动",
          primary_attr: "vitality", attr_reason: "x", parent_quest_id: main.id,
        }),
        createToolContext(),
      );
      expect(r.ok).toBe(true);
    }
    const overflow = executeTool(
      db, userId, "create_quest",
      JSON.stringify({
        title: "第 7 个", type: "mainline_milestone", category: "独自运动",
        primary_attr: "vitality", attr_reason: "x", parent_quest_id: main.id,
      }),
      createToolContext(),
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.summary).toContain("拆满");
  });

  it("主线被接受后不可再追加里程碑", () => {
    createMainline();
    const main = db.select().from(quests).where(eq(quests.type, "mainline")).get()!;
    executeTool(db, userId, "respond_to_quest", JSON.stringify({ quest_id: main.id, action: "accept" }), createToolContext());
    const r = executeTool(
      db, userId, "create_quest",
      JSON.stringify({
        title: "追加", type: "mainline_milestone", category: "独自运动",
        primary_attr: "vitality", attr_reason: "x", parent_quest_id: main.id,
      }),
      createToolContext(),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("不可再追加");
  });
});

describe("主线达成（V2.0）", () => {
  it("接受主线时一起激活里程碑；最后一个里程碑结清 → 主线达成 + 章节奖励", () => {
    const ctx = createToolContext();
    // 主线 + 两个里程碑（拆解期完成）
    executeTool(db, userId, "create_quest", JSON.stringify({
      title: "跑完一次半马", type: "mainline", category: "独自运动",
      primary_attr: "vitality", attr_reason: "耐力大目标",
    }), ctx);
    const main = db.select().from(quests).where(eq(quests.type, "mainline")).get()!;
    for (const [i, title] of ["能连续跑 5 公里", "报名并完赛"].entries()) {
      executeTool(db, userId, "create_quest", JSON.stringify({
        title, type: "mainline_milestone", category: "独自运动",
        primary_attr: "vitality", attr_reason: "耐力大目标", parent_quest_id: main.id,
        difficulty: 1,
      }), ctx);
    }

    // 接受主线：里程碑一并激活
    const accept = executeTool(db, userId, "respond_to_quest", JSON.stringify({ quest_id: main.id, action: "accept" }), ctx);
    expect(accept.ok).toBe(true);
    expect((accept.data as { milestones_activated: number }).milestones_activated).toBe(2);
    const kids = db.select().from(quests).where(eq(quests.parentQuestId, main.id)).all();
    expect(kids.every((k) => k.status === "active")).toBe(true);

    // 主线本身不可直接结算
    const direct = executeTool(db, userId, "settle_completion", JSON.stringify({
      quest_id: main.id, completion_ratio: 1, confidence: 0.9,
    }), createToolContext());
    expect(direct.ok).toBe(false);
    expect(direct.summary).toContain("里程碑");

    // 完成第一个里程碑：主线仍未达成
    const first = kids.find((k) => k.title === "能连续跑 5 公里")!;
    executeTool(db, userId, "settle_completion", JSON.stringify({
      quest_id: first.id, completion_ratio: 1, confidence: 0.9,
    }), createToolContext(() => 0.99));
    expect(db.select().from(quests).where(eq(quests.id, main.id)).get()!.status).toBe("active");

    // 完成第二个：主线完成 + 章节奖励留痕
    const goldBefore = db.select().from(character).where(eq(character.userId, userId)).get()!.gold;
    const second = kids.find((k) => k.title === "报名并完赛")!;
    const r = executeTool(db, userId, "settle_completion", JSON.stringify({
      quest_id: second.id, completion_ratio: 1, confidence: 0.95,
    }), createToolContext(() => 0.99));
    expect(r.ok).toBe(true);
    expect(db.select().from(quests).where(eq(quests.id, main.id)).get()!.status).toBe("completed");

    const bonusLog = db.select().from(settlementLog).where(eq(settlementLog.kind, "mainline_complete")).get()!;
    expect(bonusLog.questId).toBe(main.id);
    expect(bonusLog.xpAwarded).toBe(60);
    expect(bonusLog.goldAwarded).toBe(40);
    const secondLog = db
      .select()
      .from(settlementLog)
      .where(and(eq(settlementLog.questId, second.id), eq(settlementLog.kind, "quest_complete")))
      .get()!;
    const goldAfter = db.select().from(character).where(eq(character.userId, userId)).get()!.gold;
    expect(goldAfter).toBe(goldBefore + secondLog.goldAwarded + 40);
    expect(db.select().from(memory).all().some((m) => m.content.includes("半马"))).toBe(true);
  });
});
