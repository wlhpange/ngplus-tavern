import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { saves } from "../../src/server/db/schema";
import {
  addMemory,
  deleteMemories,
  listMemories,
  loadMemories,
  loadMemoriesForScope,
  setMemoryEnabled,
  updateMemory,
  saveExtractedMemories,
} from "../../src/server/memory";
import { getChatMasterId, setChatMaster } from "../../src/server/masters";
import { runChatConversation, extractChatMemories, ensureChatGreeting } from "../../src/server/llm/conversation";
import { ensureActiveSession, createSession } from "../../src/server/chatSessions";
import { VILA_MASTER_ID, GALO_MASTER_ID } from "../../src/server/db/seed";
import { createTestDb, ScriptedModel, text } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

describe("P12 记忆书", () => {
  it("按会长隔离：只加载当前会长的条目", () => {
    addMemory(db, userId, VILA_MASTER_ID, "goal", "薇拉的目标");
    addMemory(db, userId, GALO_MASTER_ID, "goal", "加洛的目标");

    const vila = loadMemories(db, userId, VILA_MASTER_ID).map((m) => m.content);
    expect(vila).toContain("薇拉的目标");
    expect(vila).not.toContain("加洛的目标");
  });

  it("查重：同一会长的重复内容只落一条；不同会长互不干扰", () => {
    expect(addMemory(db, userId, VILA_MASTER_ID, "preference", "喜欢喝黑咖啡")).toBeTruthy();
    expect(addMemory(db, userId, VILA_MASTER_ID, "preference", "喜欢喝黑咖啡")).toBeNull();
    // 另一位会长可以记同样的内容（各自的记忆书）
    expect(addMemory(db, userId, GALO_MASTER_ID, "preference", "喜欢喝黑咖啡")).toBeTruthy();
  });

  it("停用的条目保留在记忆书里，但不注入提示词", () => {
    const id = addMemory(db, userId, VILA_MASTER_ID, "profile", "夜班程序员")!;
    expect(loadMemories(db, userId, VILA_MASTER_ID).some((m) => m.content === "夜班程序员")).toBe(true);

    setMemoryEnabled(db, userId, id, false);
    expect(loadMemories(db, userId, VILA_MASTER_ID).some((m) => m.content === "夜班程序员")).toBe(false);
    // 仍能在记忆书列表里看到（可再启用 / 编辑）
    expect(listMemories(db, userId, VILA_MASTER_ID).some((m) => m.id === id && !m.enabled)).toBe(true);
  });

  it("编辑条目正文", () => {
    const id = addMemory(db, userId, VILA_MASTER_ID, "event", "旧内容")!;
    expect(updateMemory(db, userId, id, "新内容")).toBe(true);
    expect(listMemories(db, userId, VILA_MASTER_ID).find((m) => m.id === id)?.content).toBe("新内容");
  });

  it("批量写入抽取结果时自动去重", () => {
    const added = saveExtractedMemories(db, userId, VILA_MASTER_ID, [
      { category: "story", content: "两人在雨夜约好去看海" },
      { category: "story", content: "两人在雨夜约好去看海" },
    ]);
    expect(added).toBe(1);
  });

  it("批量删除：一次删掉多条", () => {
    const a = addMemory(db, userId, VILA_MASTER_ID, "event", "事件一")!;
    const b = addMemory(db, userId, VILA_MASTER_ID, "event", "事件二")!;
    const c = addMemory(db, userId, VILA_MASTER_ID, "event", "事件三")!;
    expect(deleteMemories(db, userId, [a, b])).toBe(2);
    expect(listMemories(db, userId, VILA_MASTER_ID).map((m) => m.id)).toEqual([c]);
  });
});

describe("P12 聊天会长与共享记忆", () => {
  it("setChatMaster 后聊天用聊天会长；未设置时跟随任务会长", () => {
    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    expect(getChatMasterId(db, userId)).toBe(save.activeMasterId);

    expect(setChatMaster(db, userId, GALO_MASTER_ID)).toBe(true);
    expect(getChatMasterId(db, userId)).toBe(GALO_MASTER_ID);

    // 清除 → 回到任务会长
    expect(setChatMaster(db, userId, null)).toBe(true);
    expect(getChatMasterId(db, userId)).toBe(save.activeMasterId);
  });

  it("聊天提示词注入聊天会长的记忆，不串入任务会长的记忆", async () => {
    addMemory(db, userId, VILA_MASTER_ID, "goal", "薇拉的专属记忆");
    addMemory(db, userId, GALO_MASTER_ID, "goal", "加洛的专属记忆");
    setChatMaster(db, userId, GALO_MASTER_ID);

    const sid = ensureActiveSession(db, userId, GALO_MASTER_ID);
    const llm = new ScriptedModel([text("……嗯。")]);
    await runChatConversation(db, userId, "在吗", sid, {
      model: llm.model,
      memoryExtractor: null,
    });

    expect(llm.calls[0].system).toContain("加洛的专属记忆");
    expect(llm.calls[0].system).not.toContain("薇拉的专属记忆");
  });

  it("extractChatMemories 把抽取结果写入该对话的私有记忆（不污染永久记忆）", async () => {
    const sid = ensureActiveSession(db, userId, VILA_MASTER_ID);
    ensureChatGreeting(db, userId, sid);
    const fake = {
      extract: async () => [{ category: "story", content: "约定一起去看海" }],
    };
    const n = await extractChatMemories(db, userId, VILA_MASTER_ID, sid, "薇拉", {
      extractor: fake,
    });
    expect(n).toBe(1);
    // 存在这段对话的私有记忆里
    expect(
      listMemories(db, userId, null, sid).map((m) => m.content),
    ).toContain("约定一起去看海");
    // 永久记忆不受影响
    expect(listMemories(db, userId, VILA_MASTER_ID).map((m) => m.content)).not.toContain(
      "约定一起去看海",
    );

    // 再抽一次同样的内容：去重，返回 0
    const n2 = await extractChatMemories(db, userId, VILA_MASTER_ID, sid, "薇拉", {
      extractor: fake,
    });
    expect(n2).toBe(0);
  });

  it("酒馆对话记忆按会话隔离：A 对话的记忆不会出现在 B 对话", async () => {
    const a = ensureActiveSession(db, userId, VILA_MASTER_ID);
    const b = createSession(db, userId, VILA_MASTER_ID, "第二段对话");
    expect(a).not.toBe(b);
    addMemory(db, userId, VILA_MASTER_ID, "story", "A 对话的约定", a);
    addMemory(db, userId, VILA_MASTER_ID, "story", "B 对话的秘密", b);

    const aMem = loadMemoriesForScope(db, userId, VILA_MASTER_ID, a).map((m) => m.content);
    expect(aMem).toContain("A 对话的约定");
    expect(aMem).not.toContain("B 对话的秘密");

    // 会长级永久记忆会进入每段对话，但对话私有记忆互不串
    addMemory(db, userId, VILA_MASTER_ID, "goal", "永久目标");
    const bMem = loadMemoriesForScope(db, userId, VILA_MASTER_ID, b).map((m) => m.content);
    expect(bMem).toContain("B 对话的秘密");
    expect(bMem).toContain("永久目标");
    expect(bMem).not.toContain("A 对话的约定");
  });
});
