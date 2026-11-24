import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { memory } from "../../src/server/db/schema";
import {
  listMemories,
  loadMemoriesForScope,
  MEMORY_PER_CATEGORY,
} from "../../src/server/memory";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

let seq = 0;
function addMemory(extra: Partial<typeof memory.$inferInsert> & { id?: string } = {}) {
  seq += 1;
  const id = extra.id ?? `m${seq}`;
  db.insert(memory)
    .values({
      id,
      userId,
      masterId: null,
      sessionId: null,
      category: "profile",
      content: id,
      enabled: 1,
      createdAt: 1_000 + seq,
      ...extra,
    })
    .run();
  return id;
}

describe("loadMemoriesForScope（提示词注入范围）", () => {
  it("任务模式：只取当前会长的永久记忆，不含别的会长/对话记忆/停用项", () => {
    addMemory({ id: "keep", masterId: "mA", content: "A 的永久" });
    addMemory({ id: "otherMaster", masterId: "mB", content: "B 的永久" });
    addMemory({ id: "session", masterId: "mA", sessionId: "s1", content: "会话记忆" });
    addMemory({ id: "disabled", masterId: "mA", enabled: 0, content: "停用" });

    const rows = loadMemoriesForScope(db, userId, "mA", null);
    expect(rows.map((r) => r.content)).toEqual(["A 的永久"]);
  });

  it("聊天模式：当前会长永久记忆 + 本会话私有记忆，不含其它会话", () => {
    addMemory({ id: "permanent", masterId: "mA", content: "永久" });
    addMemory({ id: "mine", masterId: "mA", sessionId: "s1", content: "本会话" });
    addMemory({ id: "other", masterId: "mA", sessionId: "s2", content: "别的会话" });
    addMemory({ id: "otherMaster", masterId: "mB", content: "别的会长" });

    const rows = loadMemoriesForScope(db, userId, "mA", "s1");
    expect(rows.map((r) => r.content).sort()).toEqual(["永久", "本会话"].sort());
  });

  it("每个类别最多注入 MEMORY_PER_CATEGORY 条，且优先最近的", () => {
    for (let i = 0; i < MEMORY_PER_CATEGORY + 3; i++) {
      addMemory({
        id: `p${i}`,
        masterId: "mA",
        category: "profile",
        content: `p${i}`,
        createdAt: 10_000 + i,
      });
    }

    const rows = loadMemoriesForScope(db, userId, "mA", null);
    expect(rows).toHaveLength(MEMORY_PER_CATEGORY);
    // 最新的在前：p8、p7、p6…
    expect(rows.map((r) => r.content)).toEqual(
      Array.from({ length: MEMORY_PER_CATEGORY }, (_, i) => `p${MEMORY_PER_CATEGORY + 2 - i}`),
    );
  });
});

describe("listMemories（设置页列表）", () => {
  it("传 sessionId 只列该会话；传 masterId 只列该会长的永久记忆", () => {
    addMemory({ id: "permanent", masterId: "mA" });
    addMemory({ id: "s1", masterId: "mA", sessionId: "s1" });
    addMemory({ id: "s2", masterId: "mA", sessionId: "s2" });

    expect(listMemories(db, userId, null, "s1").map((r) => r.id)).toEqual(["s1"]);
    expect(listMemories(db, userId, "mA").map((r) => r.id)).toEqual(["permanent"]);
  });
});
