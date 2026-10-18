import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { wrapLanguageModel, simulateStreamingMiddleware, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Db } from "../../src/server/db";
import { chatLog, character } from "../../src/server/db/schema";
import {
  runConversation,
  type ConversationStreamEvent,
} from "../../src/server/llm/conversation";
import { createTestDb, ScriptedModel, text } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

describe("P11 · 失败回滚（重发不重复入库）", () => {
  it("模型抛错：本轮 chat_log 全部回滚，用户消息不残留", async () => {
    const boom = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("模型炸了");
      },
    }) as unknown as LanguageModel;

    await expect(
      runConversation(db, userId, "你好呀", {
        model: boom,
        reviewer: null,
        memoryReviewer: null,
        dailyRand: () => 1,
      }),
    ).rejects.toThrow("模型炸了");

    const rows = db.select().from(chatLog).where(eq(chatLog.userId, userId)).all();
    expect(rows).toHaveLength(0);
  });

  it("重发一次成功：库里只有一条用户消息（不重复）", async () => {
    const boom = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("网络抖动");
      },
    }) as unknown as LanguageModel;
    await expect(
      runConversation(db, userId, "今天跑了三公里", {
        model: boom,
        reviewer: null,
        memoryReviewer: null,
        dailyRand: () => 1,
      }),
    ).rejects.toThrow();

    // 用户重发（同一条文字），这次成功
    const ok = new ScriptedModel([text("记上了。")]);
    const r = await runConversation(db, userId, "今天跑了三公里", {
      model: ok.model,
      reviewer: null,
      memoryReviewer: null,
      dailyRand: () => 1,
    });
    expect(r.replyText).toContain("记上了");

    const userRows = db
      .select()
      .from(chatLog)
      .where(eq(chatLog.userId, userId))
      .all()
      .filter((row) => row.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0].content).toBe("今天跑了三公里");
  });
});

describe("P11 · 前缀缓存（稳定 system + 易变上下文后置）", () => {
  it("状态变化的两轮之间 system 参数逐字节相同；状态进入 messages 的 system 注记", async () => {
    const llm1 = new ScriptedModel([text("第一轮。")]);
    await runConversation(db, userId, "第一句", {
      model: llm1.model,
      reviewer: null,
      memoryReviewer: null,
      dailyRand: () => 1,
    });

    // 改变易变状态（金币 / 总经验）
    db.update(character)
      .set({ gold: 999, totalXp: 1234 })
      .where(eq(character.userId, userId))
      .run();

    const llm2 = new ScriptedModel([text("第二轮。")]);
    await runConversation(db, userId, "第二句", {
      model: llm2.model,
      reviewer: null,
      memoryReviewer: null,
      dailyRand: () => 1,
    });

    // system 参数（稳定前缀）两轮完全一致 → 支持前缀缓存的模型/网关可命中
    expect(llm1.calls[0].systemParam).toBe(llm2.calls[0].systemParam);
    expect(llm2.calls[0].systemParam).toContain("你无权在文本中声明任何数值变更");
    // 易变状态不在 system 参数里，而在 messages 的 system 注记里
    expect(llm2.calls[0].systemParam).not.toContain("【当前状态");
    expect(llm2.calls[0].system).toContain("【当前状态");
    expect(llm2.calls[0].system).toContain("金币 999");
  });
});

describe("P11 · 流式输出（onEvent）", () => {
  it("onEvent 收到 delta，最终结果与一次性调用一致", async () => {
    const scripted = new ScriptedModel([text("记上了。第 1 天，先这样。")]);
    const model = wrapLanguageModel({
      model: scripted.model as unknown as LanguageModelV4,
      middleware: simulateStreamingMiddleware(),
    });

    const events: ConversationStreamEvent[] = [];
    const r = await runConversation(db, userId, "今天跑了三公里", {
      model,
      reviewer: null,
      memoryReviewer: null,
      dailyRand: () => 1,
      onEvent: (e) => events.push(e),
    });

    // 增量拼起来 = 完整正文
    const streamed = events
      .filter((e): e is Extract<ConversationStreamEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(streamed).toContain("记上了");
    expect(streamed).toContain("第 1 天");
    expect(r.replyText).toContain("记上了");

    // 一段用户 + 一段会长，正常落库
    const rows = db.select().from(chatLog).where(eq(chatLog.userId, userId)).all();
    expect(rows.filter((x) => x.role === "user")).toHaveLength(1);
    expect(rows.filter((x) => x.role === "master")).toHaveLength(1);
  });
});
