import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { chatLog, quests, settlementLog } from "../../src/server/db/schema";
import { chatWindowStart, hasRecordsBefore, queryRecords } from "../../src/server/records";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function addMessage(id: string, role: "user" | "master", content: string, at: number, mode: "quest" | "chat" = "quest") {
  db.insert(chatLog)
    .values({ id, userId, role, content, masterId: null, mode, createdAt: at })
    .run();
}

function addSettlement(id: string, at: number, extra: Partial<typeof settlementLog.$inferInsert> = {}) {
  db.insert(settlementLog)
    .values({
      id,
      userId,
      questId: null,
      kind: "quest_complete",
      xpAwarded: 10,
      goldAwarded: 5,
      attrSplitJson: "{}",
      createdAt: at,
      ...extra,
    })
    .run();
}

describe("对话窗口起点（三天规则）", () => {
  it("今天/昨天/前天：9月27日任意时刻 → 9月25日 0 点", () => {
    const start = chatWindowStart(new Date(2026, 8, 27, 10, 30));
    expect(new Date(start).getMonth()).toBe(8);
    expect(new Date(start).getDate()).toBe(25);
    expect(new Date(start).getHours()).toBe(0);
  });

  it("跨月边界：10月1日 → 9月29日 0 点", () => {
    const start = chatWindowStart(new Date(2026, 9, 1, 0, 5));
    expect(new Date(start).getMonth()).toBe(8);
    expect(new Date(start).getDate()).toBe(29);
  });
});

describe("queryRecords（归档查询）", () => {
  const base = new Date(2026, 8, 27, 12, 0).getTime();

  it("倒序返回，同刻按「会长回复 → 结算 → 用户发言」的相对先后反转", () => {
    addMessage("u1", "user", "跑完了", base);
    addSettlement("s1", base);
    addMessage("m1", "master", "记上了", base);
    addMessage("u2", "user", "更早的问题", base - 60_000);
    addMessage("m2", "master", "更早的回答", base - 59_000);

    const r = queryRecords(db, userId, { limit: 10 });
    const ids = r.items.map((it) => (it.type === "message" ? it.id : it.settlement.id));
    expect(ids).toEqual(["m1", "s1", "u1", "m2", "u2"]);
    expect(r.hasMore).toBe(false);
  });

  it("分页：limit + 游标往下翻，hasMore/nextBefore 正确", () => {
    for (let i = 0; i < 5; i++) {
      addMessage(`m${i}`, "user", `第 ${i} 条`, base - i * 1000);
    }
    const p1 = queryRecords(db, userId, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextBefore).toBe(base - 1000);

    const p2 = queryRecords(db, userId, { limit: 2, before: p1.nextBefore });
    const ids = p2.items.map((it) => (it.type === "message" ? it.id : ""));
    expect(ids).toEqual(["m2", "m3"]);
    expect(p2.hasMore).toBe(true);

    const p3 = queryRecords(db, userId, { limit: 2, before: p2.nextBefore });
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it("kind=chat 只出消息；kind=settlement 只出结算", () => {
    addMessage("u1", "user", "hello", base);
    addSettlement("s1", base - 1000);

    const chat = queryRecords(db, userId, { kind: "chat" });
    expect(chat.items.every((it) => it.type === "message")).toBe(true);

    const settle = queryRecords(db, userId, { kind: "settlement" });
    expect(settle.items.every((it) => it.type === "settlement")).toBe(true);
  });

  it("settlementKinds：结算流可按类别筛选（月账单筛选用）", () => {
    addSettlement("s1", base, { kind: "quest_complete" });
    addSettlement("s2", base - 1000, { kind: "purchase", goldAwarded: -100 });
    addSettlement("s3", base - 2000, { kind: "gift" });

    const r = queryRecords(db, userId, {
      kind: "settlement",
      settlementKinds: ["purchase", "gift"],
    });
    const ids = r.items.map((it) =>
      it.type === "settlement" ? it.settlement.id : "?",
    );
    expect(ids).toEqual(["s2", "s3"]);
  });

  it("关键词：消息查正文，结算查委托名", () => {
    db.insert(quests)
      .values({
        id: "q1",
        userId,
        title: "周末徒步 15 公里",
        type: "once",
        primaryAttr: "vitality",
        status: "completed",
        createdAt: base,
      })
      .run();
    addSettlement("s1", base, { questId: "q1" });
    addMessage("u1", "user", "今天去徒步了", base - 1000);
    addMessage("u2", "user", "今天读书了", base - 2000);

    const byMsg = queryRecords(db, userId, { q: "徒步", kind: "chat" });
    expect(byMsg.items).toHaveLength(1);
    expect((byMsg.items[0] as { content: string }).content).toContain("徒步");

    const byQuest = queryRecords(db, userId, { q: "徒步", kind: "settlement" });
    expect(byQuest.items).toHaveLength(1);
    expect(byQuest.items[0]).toMatchObject({
      type: "settlement",
      settlement: { questTitle: "周末徒步 15 公里" },
    });
  });

  it("since 窗口：只取三天内的内容（对话主界面用）", () => {
    const start = chatWindowStart(new Date(base));
    addMessage("old", "user", "上周的话", start - 10_000);
    addMessage("new", "user", "今天的话", start + 10_000);
    const r = queryRecords(db, userId, { since: start, limit: 10 });
    expect(r.items).toHaveLength(1);
    expect((r.items[0] as { id: string }).id).toBe("new");
  });
});

describe("hasRecordsBefore（窗口外是否还有内容）", () => {
  it("窗口前有消息或有结算 → true；否则 false", () => {
    const line = new Date(2026, 8, 25).getTime();
    expect(hasRecordsBefore(db, userId, line)).toBe(false);
    addMessage("u1", "user", "旧消息", line - 1000);
    expect(hasRecordsBefore(db, userId, line)).toBe(true);
  });

  it("只有结算在窗口前也算", () => {
    const line = new Date(2026, 8, 25).getTime();
    addSettlement("s1", line - 1000);
    expect(hasRecordsBefore(db, userId, line)).toBe(true);
  });
});

describe("P0 对话模式隔离（quest / chat 两条流）", () => {
  const base = new Date(2026, 8, 27, 12, 0).getTime();

  it("queryRecords 默认只出任务流；mode=chat 只出聊天流", () => {
    addMessage("q1", "user", "任务：跑完了", base);
    addMessage("c1", "user", "聊天：今天天气不错", base - 1000, "chat");

    const quest = queryRecords(db, userId, { limit: 10 });
    const questIds = quest.items.map((it) => (it.type === "message" ? it.id : ""));
    expect(questIds).toEqual(["q1"]);

    const chat = queryRecords(db, userId, { limit: 10, mode: "chat" });
    const chatIds = chat.items.map((it) => (it.type === "message" ? it.id : ""));
    expect(chatIds).toEqual(["c1"]);
  });

  it("聊天模式不并入结算卡片（结算是任务管线专属）", () => {
    addMessage("c1", "user", "聊天一句", base, "chat");
    addSettlement("s1", base);

    const chat = queryRecords(db, userId, { mode: "chat", limit: 10 });
    expect(chat.items.every((it) => it.type === "message")).toBe(true);
    expect(chat.items).toHaveLength(1);
  });

  it("按会话翻页：不受三天窗口限制，before 游标能取到更早的会话消息", () => {
    const old = new Date(2026, 0, 1).getTime(); // 半年前，远超三天窗口
    for (let i = 0; i < 5; i++) {
      db.insert(chatLog)
        .values({
          id: `s${i}`,
          userId,
          role: "user",
          content: `会话消息 ${i}`,
          masterId: null,
          mode: "chat",
          sessionId: "sess-A",
          createdAt: old + i * 1000,
        })
        .run();
    }
    // 另一会话的消息不应串进来
    db.insert(chatLog)
      .values({
        id: "other",
        userId,
        role: "user",
        content: "别的会话",
        masterId: null,
        mode: "chat",
        sessionId: "sess-B",
        createdAt: old,
      })
      .run();

    const p1 = queryRecords(db, userId, { mode: "chat", sessionId: "sess-A", limit: 2 });
    expect(p1.hasMore).toBe(true);
    const p1ids = p1.items.map((it) => (it.type === "message" ? it.id : ""));
    // queryRecords 倒序返回（最新在前）；对话页会再反转成正序渲染
    expect(p1ids).toEqual(["s4", "s3"]);

    const p2 = queryRecords(db, userId, {
      mode: "chat",
      sessionId: "sess-A",
      limit: 2,
      before: p1.nextBefore,
    });
    expect(p2.items.every((it) => it.type === "message" && it.id !== "other")).toBe(true);
    const p2ids = p2.items.map((it) => (it.type === "message" ? it.id : ""));
    expect(p2ids).toEqual(["s2", "s1"]);
  });

  it("hasRecordsBefore 按模式判断；聊天模式忽略结算", () => {
    const line = new Date(2026, 8, 25).getTime();
    // 只有结算在窗口前：任务流 true，聊天流 false
    addSettlement("s-old", line - 500);
    expect(hasRecordsBefore(db, userId, line, "quest")).toBe(true);
    expect(hasRecordsBefore(db, userId, line, "chat")).toBe(false);

    // 聊天流自己有窗口前消息 → true；任务流不受聊天消息影响
    addMessage("c-old", "user", "旧聊天消息", line - 2000, "chat");
    expect(hasRecordsBefore(db, userId, line, "chat")).toBe(true);
    addSettlement("s-old2", line - 300);
    addMessage("q-old", "user", "旧任务消息", line - 1000, "quest");
    expect(hasRecordsBefore(db, userId, line, "quest")).toBe(true);
  });
});
