import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { chatLog, saves } from "../../src/server/db/schema";
import {
  createSession,
  listSessions,
  getSession,
  renameSession,
  deleteSession,
  ensureActiveSession,
  sessionHasUserMessage,
} from "../../src/server/chatSessions";
import {
  ensureChatGreeting,
  runChatConversation,
} from "../../src/server/llm/conversation";
import { createTestDb, ScriptedModel, text } from "./helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function masterId(): string {
  return db.select().from(saves).where(eq(saves.userId, userId)).get()!.activeMasterId!;
}

describe("P10 聊天会话 · 数据层", () => {
  it("新建/列举/改名/删除", () => {
    const a = createSession(db, userId, masterId(), "初遇");
    const b = createSession(db, userId, masterId(), "雨夜谈心");
    let list = listSessions(db, userId, masterId());
    expect(list.map((s) => s.title).sort()).toEqual(["初遇", "雨夜谈心"].sort());

    renameSession(db, userId, a, "正式初遇");
    expect(getSession(db, userId, a)?.title).toBe("正式初遇");

    deleteSession(db, userId, b);
    list = listSessions(db, userId, masterId());
    expect(list.map((s) => s.title)).toEqual(["正式初遇"]);
  });

  it("ensureActiveSession：没有会话时自动建一条，有则复用最近一条", () => {
    const first = ensureActiveSession(db, userId, masterId());
    const again = ensureActiveSession(db, userId, masterId());
    expect(again).toBe(first);
    expect(listSessions(db, userId, masterId())).toHaveLength(1);
  });
});

describe("P10 聊天会话 · 历史隔离", () => {
  it("两段会话各聊各的，上下文互不串", async () => {
    const s1 = createSession(db, userId, masterId(), "会话一");
    const s2 = createSession(db, userId, masterId(), "会话二");

    const llm1 = new ScriptedModel([text("会话一的回答")]);
    await runChatConversation(db, userId, "会话一的问题", s1, { model: llm1.model });

    const llm2 = new ScriptedModel([text("会话二的回答")]);
    await runChatConversation(db, userId, "会话二的问题", s2, { model: llm2.model });

    expect(llm2.calls[0].messages.some((m) => m.text === "会话一的问题")).toBe(false);
    expect(llm2.calls[0].messages.some((m) => m.text === "会话一的回答")).toBe(false);
    expect(llm2.calls[0].messages.some((m) => m.text === "会话二的问题")).toBe(true);

    const llm3 = new ScriptedModel([text("会话一的第二答")]);
    await runChatConversation(db, userId, "会话一的第二问", s1, { model: llm3.model });
    expect(llm3.calls[0].messages.some((m) => m.text === "会话二的问题")).toBe(false);
    expect(llm3.calls[0].messages.some((m) => m.text === "会话一的问题")).toBe(true);
  });

  it("开场白按会话独立落库", () => {
    const s1 = createSession(db, userId, masterId(), "A");
    const s2 = createSession(db, userId, masterId(), "B");
    ensureChatGreeting(db, userId, s1);
    ensureChatGreeting(db, userId, s2);
    expect(db.select().from(chatLog).where(eq(chatLog.sessionId, s1)).all()).toHaveLength(1);
    expect(db.select().from(chatLog).where(eq(chatLog.sessionId, s2)).all()).toHaveLength(1);
  });

  it("sessionHasUserMessage：开场白不算，用户发言算", async () => {
    const s1 = createSession(db, userId, masterId(), "A");
    ensureChatGreeting(db, userId, s1);
    expect(sessionHasUserMessage(db, userId, s1)).toBe(false);
    const llm = new ScriptedModel([text("嗯。")]);
    await runChatConversation(db, userId, "你好", s1, { model: llm.model });
    expect(sessionHasUserMessage(db, userId, s1)).toBe(true);
  });

  it("删除会话连带其消息；别的会话不受影响", async () => {
    const s1 = createSession(db, userId, masterId(), "A");
    const s2 = createSession(db, userId, masterId(), "B");
    const llm = new ScriptedModel([text("嗯。")]);
    await runChatConversation(db, userId, "在 A 里说话", s1, { model: llm.model });

    deleteSession(db, userId, s1);
    expect(db.select().from(chatLog).where(eq(chatLog.sessionId, s1)).all()).toHaveLength(0);
    expect(listSessions(db, userId, masterId()).map((s) => s.id)).toContain(s2);
  });
});
