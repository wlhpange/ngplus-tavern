import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { chatLog, saves, quests, settlementLog } from "../../src/server/db/schema";
import { runChatConversation, runConversation, ensureChatGreeting } from "../../src/server/llm/conversation";
import { ensureActiveSession } from "../../src/server/chatSessions";
import { switchMaster, addAffinityPoints, getAffinity } from "../../src/server/masters";
import { GALO_MASTER_ID, VILA_MASTER_ID } from "../../src/server/db/seed";
import { createBook, replaceBookEntries, assignBook } from "../../src/server/worldbook";
import { setRpEnabled } from "../../src/server/rp";
import { createTestDb, ScriptedModel, text, toolCall } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

/** 当前会长的活跃会话（测试用） */
function sid(): string {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
  return ensureActiveSession(db, userId, save.activeMasterId!);
}

describe("P0 聊天（酒馆）管线", () => {
  it("纯文本回复：落库为 mode=chat，且不过 sanitizeReply（破折号/markdown/emoji 原样保留）", async () => {
    const raw = "哟——好久不见。**今天**过得怎么样？🌸";
    const llm = new ScriptedModel([text(raw)]);
    const r = await runChatConversation(db, userId, "会长，我来啦", sid(), { model: llm.model });

    // sanitizeReply 会把 —— 变句号、去 markdown 与 emoji；聊天模式刻意保留
    expect(r.replyText).toBe(raw);

    const rows = db.select().from(chatLog).where(eq(chatLog.mode, "chat")).all();
    expect(rows.map((x) => x.role).sort()).toEqual(["master", "user"]);
    expect(rows.every((x) => x.mode === "chat")).toBe(true);
    // 聊天模式只调一次模型、不发起任何工具调用
    expect(llm.calls).toHaveLength(1);
  });

  it("历史隔离：任务管线的消息不进入聊天模式的上下文", async () => {
    // 先跑一轮任务管线，落一条 quest 历史
    const questLlm = new ScriptedModel([
      toolCall("c1", "create_quest", {
        title: "每天背单词",
        type: "daily",
        category: "课程学习",
        primary_attr: "mind",
        attr_reason: "认知活动",
      }),
      text("委托拟好了"),
    ]);
    await runConversation(db, userId, "我想每天背单词", { model: questLlm.model, dailyRand: () => 1 });

    // 聊天模式：系统提示词与历史都应是聊天流自己的
    const chatLlm = new ScriptedModel([text("嗯，我在。")]);
    await runChatConversation(db, userId, "聊聊别的", sid(), { model: chatLlm.model });

    const call = chatLlm.calls[0];
    expect(call.system).toContain("角色扮演");
    expect(call.system).not.toContain("你无权在文本中声明任何数值变更");
    // 任务管线的消息没串进来
    expect(call.messages.some((m) => m.text.includes("我想每天背单词"))).toBe(false);
  });

  it("聊天不再注入亲密度关系阶段（与任务页解耦，只共用角色卡）", async () => {
    // 把薇拉的好感推到 stage 2，聊天提示词里也不应出现「熟络」
    addAffinityPoints(db, userId, VILA_MASTER_ID, 8);
    const llm = new ScriptedModel([text("小冒险家，今天想聊点什么？")]);
    await runChatConversation(db, userId, "在吗", sid(), { model: llm.model });
    expect(llm.calls[0].system).not.toContain("「熟络」");
    expect(llm.calls[0].system).toContain("「小冒险家」");
  });

  it("聊天模式不触发任何任务引擎副作用（无委托、无结算）", async () => {
    const llm = new ScriptedModel([text("好呀。")]);
    await runChatConversation(db, userId, "我想每天背单词", sid(), { model: llm.model });
    expect(db.select().from(quests).all()).toHaveLength(0);
    expect(db.select().from(settlementLog).all()).toHaveLength(0);
  });

  it("聊天历史按 mode 过滤并作为上下文回注", async () => {
    const llm1 = new ScriptedModel([text("第一句回复")]);
    await runChatConversation(db, userId, "第一句", sid(), { model: llm1.model });

    const llm2 = new ScriptedModel([text("第二句回复")]);
    await runChatConversation(db, userId, "第二句", sid(), { model: llm2.model });
    expect(llm2.calls[0].messages.some((m) => m.text === "第一句")).toBe(true);
    expect(llm2.calls[0].messages.some((m) => m.text === "第一句回复")).toBe(true);
  });
});

describe("P1 聊天开场白与任期隔离", () => {
  it("任期内没有消息时，落一条卡面开场白（幂等）", () => {
    ensureChatGreeting(db, userId, sid());
    const rows = db.select().from(chatLog).where(eq(chatLog.mode, "chat")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("master");
    // 薇拉的 first_mes
    expect(rows[0].content).toContain("茶刚沏上");
    // 幂等：已有消息不再插
    ensureChatGreeting(db, userId, sid());
    expect(db.select().from(chatLog).where(eq(chatLog.mode, "chat")).all()).toHaveLength(1);
  });

  it("换会长后聊天历史从新任期重新开始（酒馆语义）", async () => {
    ensureChatGreeting(db, userId, sid());
    const llm1 = new ScriptedModel([text("旧会长的回答")]);
    await runChatConversation(db, userId, "旧会话的问题", sid(), { model: llm1.model });

    // 等一毫秒，保证新任期起点严格晚于旧消息
    await new Promise((r) => setTimeout(r, 5));
    await switchMaster(db, userId, GALO_MASTER_ID);
    ensureChatGreeting(db, userId, sid());

    const llm2 = new ScriptedModel([text("新会长的回答")]);
    await runChatConversation(db, userId, "新会话的问题", sid(), { model: llm2.model });

    // 旧任期的消息不进新会长的上下文
    expect(llm2.calls[0].messages.some((m) => m.text === "旧会话的问题")).toBe(false);
    expect(llm2.calls[0].messages.some((m) => m.text === "旧会长的回答")).toBe(false);
    // 新会长开场白（先于本轮用户消息）在上下文里
    expect(llm2.calls[0].messages.some((m) => m.text.includes("坐直点"))).toBe(true);
    // 系统提示词是加洛的卡
    expect(llm2.calls[0].system).toContain("加洛");
  });
});

describe("P11 聊天不再推进亲密度", () => {
  it("聊天回合不改变任何会长的亲密度（送礼才是唯一入口）", async () => {
    const llm = new ScriptedModel([text("嗯。")]);
    await runChatConversation(db, userId, "在吗", sid(), { model: llm.model });
    expect(getAffinity(db, userId, VILA_MASTER_ID).points).toBe(0);
  });
});

describe("P4 R18 内容接入", () => {
  it("默认不注入尺度提示；开启后注入 Evening-Truth 解禁层", async () => {
    const off = new ScriptedModel([text("好")]);
    await runChatConversation(db, userId, "在吗", sid(), { model: off.model });
    expect(off.calls[0].system).not.toContain("IMPORTANT ROLE-PLAY GUIDELINE");
    expect(off.calls[0].system).not.toContain("保持含蓄");

    setRpEnabled(db, true);
    const on = new ScriptedModel([text("好")]);
    await runChatConversation(db, userId, "继续", sid(), { model: on.model });
    expect(on.calls[0].system).toContain("IMPORTANT ROLE-PLAY GUIDELINE");
  });
});

describe("P2 世界书注入", () => {
  it("常驻进系统提示词；at_depth system 并入系统提示；at_depth user 注入历史且都不落库", async () => {
    // 挂给当前会长（薇拉）
    const book = createBook(db, userId, "协会设定");
    replaceBookEntries(db, userId, book, [
      { keys: [], content: "协会坐落在旧钟楼。", constant: true, position: "before" },
      { keys: [], content: "深度提示：今晚下雨。", constant: true, position: "at_depth", depth: 1 },
      {
        keys: [],
        content: "旁白：门被风吹开。",
        constant: true,
        position: "at_depth",
        depth: 1,
        role: "user",
      },
    ]);
    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    assignBook(db, userId, save.activeMasterId!, book);

    const llm = new ScriptedModel([text("好的")]);
    await runChatConversation(db, userId, "在吗", sid(), { model: llm.model });

    expect(llm.calls[0].system).toContain("协会坐落在旧钟楼。");
    expect(llm.calls[0].system).toContain("深度提示");
    expect(llm.calls[0].messages.some((m) => m.text.includes("旁白"))).toBe(true);
    // 注入只在本回合提示词，不写进 chat_log
    const stored = db.select().from(chatLog).all().map((r) => r.content).join("\n");
    expect(stored).not.toContain("深度提示");
    expect(stored).not.toContain("旁白");
  });
});
