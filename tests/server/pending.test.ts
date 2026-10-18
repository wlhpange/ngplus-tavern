import { describe, it, expect } from "vitest";
import {
  pendingKey,
  markPending,
  clearPending,
  isPending,
  __resetPendingMemory,
} from "../../src/server/llm/pending";
import { createTestDb } from "../llm/helpers";

describe("llm/pending · 在途回合登记", () => {
  it("默认无登记；mark 后为 true，clear 后回到 false", () => {
    const key = pendingKey("u1", "chat", "s1");
    expect(isPending(key)).toBe(false);
    markPending(key);
    expect(isPending(key)).toBe(true);
    clearPending(key);
    expect(isPending(key)).toBe(false);
  });

  it("键按 用户+模式+会话 隔离", () => {
    const chatS1 = pendingKey("u1", "chat", "s1");
    const chatS2 = pendingKey("u1", "chat", "s2");
    const quest = pendingKey("u1", "quest", null);
    markPending(chatS1);
    expect(isPending(chatS1)).toBe(true);
    expect(isPending(chatS2)).toBe(false);
    expect(isPending(quest)).toBe(false);
  });

  it("会话为空时任务模式键稳定一致", () => {
    expect(pendingKey("u1", "quest")).toBe(pendingKey("u1", "quest", null));
  });

  it("内存丢失后从数据库镜像恢复（刷新 / 模块重编译）", () => {
    const { db } = createTestDb();
    const key = pendingKey("u1", "chat", "s1");
    markPending(key, db);
    __resetPendingMemory(); // 模拟进程内状态丢失
    expect(isPending(key, db)).toBe(true);
    clearPending(key, db);
    __resetPendingMemory();
    expect(isPending(key, db)).toBe(false);
  });
});
