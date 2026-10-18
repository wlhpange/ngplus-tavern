import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { chatLog, settlementLog } from "../../src/server/db/schema";
import { runConversation } from "../../src/server/llm/conversation";
import { queryRecords } from "../../src/server/records";
import { switchMaster } from "../../src/server/masters";
import { GALO_MASTER_ID, VILA_MASTER_ID } from "../../src/server/db/seed";
import { createTestDb, ScriptedModel, text } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

const opts = { reviewer: null, memoryReviewer: null, dailyRand: () => 1 } as const;

describe("P11 任务对话按会长分（每会长一条主线）", () => {
  it("用户消息带上当前会长；换会长后新会长的上下文不含旧会长的话", async () => {
    const llm1 = new ScriptedModel([text("薇拉的回答")]);
    await runConversation(db, userId, "薇拉你好", { model: llm1.model, ...opts });

    // 用户消息也归属当前会长
    const users = db.select().from(chatLog).where(eq(chatLog.role, "user")).all();
    expect(users).toHaveLength(1);
    expect(users[0].masterId).toBe(VILA_MASTER_ID);

    await switchMaster(db, userId, GALO_MASTER_ID);
    const llm2 = new ScriptedModel([text("加洛的回答")]);
    await runConversation(db, userId, "加洛你好", { model: llm2.model, ...opts });

    const ctxTexts = llm2.calls[0].messages.map((m) => m.text);
    expect(ctxTexts.some((t) => t.includes("薇拉你好"))).toBe(false);
    expect(ctxTexts.some((t) => t.includes("薇拉的回答"))).toBe(false);
    expect(ctxTexts.some((t) => t.includes("加洛你好"))).toBe(true);
  });

  it("queryRecords 按会长过滤任务消息（结算仍全局）", async () => {
    const llm1 = new ScriptedModel([text("薇拉的回答")]);
    await runConversation(db, userId, "薇拉的问题", { model: llm1.model, ...opts });
    await switchMaster(db, userId, GALO_MASTER_ID);

    const vila = queryRecords(db, userId, { mode: "quest", masterId: VILA_MASTER_ID });
    const galo = queryRecords(db, userId, { mode: "quest", masterId: GALO_MASTER_ID });

    const vilaText = vila.items.filter((i) => i.type === "message").map((i) => i.content);
    const galoText = galo.items.filter((i) => i.type === "message").map((i) => i.content);
    expect(vilaText).toContain("薇拉的问题");
    expect(galoText).not.toContain("薇拉的问题");
  });

  it("结算卡片按「结算当时在任的会长」归属", async () => {
    const insertSettlement = (id: string) =>
      db
        .insert(settlementLog)
        .values({
          id,
          userId,
          questId: null,
          kind: "purchase",
          xpAwarded: 0,
          goldAwarded: -10,
          attrSplitJson: "{}",
          createdAt: Date.now(),
        })
        .run();

    insertSettlement("s_vila");
    await new Promise((r) => setTimeout(r, 5));
    await switchMaster(db, userId, GALO_MASTER_ID);
    insertSettlement("s_galo");

    const settleIds = (masterId: string) =>
      queryRecords(db, userId, { mode: "quest", masterId })
        .items.flatMap((i) => (i.type === "settlement" ? [i.settlement.id] : []));

    expect(settleIds(VILA_MASTER_ID)).toContain("s_vila");
    expect(settleIds(VILA_MASTER_ID)).not.toContain("s_galo");
    expect(settleIds(GALO_MASTER_ID)).toContain("s_galo");
    expect(settleIds(GALO_MASTER_ID)).not.toContain("s_vila");
    // 不传 masterId（归档页）：全局都能看到
    const all = queryRecords(db, userId, { mode: "quest" }).items.flatMap((i) =>
      i.type === "settlement" ? [i.settlement.id] : [],
    );
    expect(all).toEqual(expect.arrayContaining(["s_vila", "s_galo"]));
  });
});

describe("P11 模型输出宏清洗", () => {
  it("回复里照抄的 {{char}}/{{user}} 被替换、未知宏被清除后落库", async () => {
    const llm = new ScriptedModel([text("{{char}} 看着 {{user}}，还有 {{unknown}}。")]);
    const r = await runConversation(db, userId, "在吗", { model: llm.model, ...opts });
    expect(r.replyText).toContain("薇拉 看着 你");
    expect(r.replyText).not.toContain("{{");

    const m = db
      .select()
      .from(chatLog)
      .where(eq(chatLog.role, "master"))
      .get()!;
    expect(m.content).not.toContain("{{");
    expect(m.content).toContain("薇拉 看着 你");
  });
});
