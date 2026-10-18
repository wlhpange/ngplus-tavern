import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { chatLog, saves } from "../../src/server/db/schema";
import {
  ensureChatGreeting,
  chatGreetingOptions,
  cycleChatGreeting,
  runChatConversation,
} from "../../src/server/llm/conversation";
import { getUserPersona, setUserPersona, buildUserPersonaLayer } from "../../src/server/userPersona";
import { ensureActiveSession } from "../../src/server/chatSessions";
import { createCustomMaster } from "../../src/server/masters";
import { replaceBookEntries, createBook, assignBook, listBookEntries, estimateTokens } from "../../src/server/worldbook";
import { createTestDb, ScriptedModel, text } from "./helpers";

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

describe("P9 开场白 swipe", () => {
  it("多开场白：cycle 依次切换，落库只有一条", () => {
    const created = createCustomMaster(db, userId, {
      name: "老周",
      brief: "一段足够长的描述文本超过五字",
      persona: {
        first_mes: "第一句开场白",
        alternate_greetings: ["第二句开场白", "第三句开场白"],
      },
    });
    db.update(saves).set({ activeMasterId: created.id }).where(eq(saves.userId, userId)).run();

    ensureChatGreeting(db, userId, sid());
    expect(chatGreetingOptions(db, userId, sid()).greetings).toHaveLength(3);

    const r1 = cycleChatGreeting(db, userId, sid());
    expect(r1.ok).toBe(true);
    expect(r1.greeting).toBe("第二句开场白");
    expect(db.select().from(chatLog).where(eq(chatLog.mode, "chat")).all()).toHaveLength(1);

    const r2 = cycleChatGreeting(db, userId, sid());
    expect(r2.greeting).toBe("第三句开场白");
    const r3 = cycleChatGreeting(db, userId, sid()); // 回卷
    expect(r3.greeting).toBe("第一句开场白");
  });

  it("只有一条开场白时不可换", () => {
    const created = createCustomMaster(db, userId, {
      name: "独句",
      brief: "一段足够长的描述文本超过五字",
      persona: { first_mes: "只有这一句" },
    });
    db.update(saves).set({ activeMasterId: created.id }).where(eq(saves.userId, userId)).run();
    ensureChatGreeting(db, userId, sid());
    expect(cycleChatGreeting(db, userId, sid()).ok).toBe(false);
  });

  it("开场白含宏（{{char}}/{{user}}）时也能依次切换，不卡在第 2 条", () => {
    const created = createCustomMaster(db, userId, {
      name: "阿岚",
      brief: "一段足够长的描述文本超过五字",
      persona: {
        first_mes: "{{char}}看向{{user}}：「来了。」",
        alternate_greetings: [
          "{{user}}，{{char}}在等你。",
          "「又是你。」{{char}}笑了笑。",
        ],
      },
    });
    db.update(saves).set({ activeMasterId: created.id }).where(eq(saves.userId, userId)).run();
    ensureChatGreeting(db, userId, sid());

    const r1 = cycleChatGreeting(db, userId, sid());
    expect(r1.ok).toBe(true);
    expect(r1.index).toBe(1);
    // 落库仍是宏展开后的正文（{{char}}→会长名、{{user}}→你）
    expect(r1.greeting).toBe("你，阿岚在等你。");

    const r2 = cycleChatGreeting(db, userId, sid());
    expect(r2.index).toBe(2);
    const r3 = cycleChatGreeting(db, userId, sid());
    expect(r3.index).toBe(0);
    // 全程只有一条开场白
    expect(db.select().from(chatLog).where(eq(chatLog.mode, "chat")).all()).toHaveLength(1);
  });

  it("用户已经开口后不可再换开场白", async () => {
    const created = createCustomMaster(db, userId, {
      name: "多句",
      brief: "一段足够长的描述文本超过五字",
      persona: { first_mes: "A", alternate_greetings: ["B"] },
    });
    db.update(saves).set({ activeMasterId: created.id }).where(eq(saves.userId, userId)).run();
    ensureChatGreeting(db, userId, sid());
    const llm = new ScriptedModel([text("嗯。")]);
    await runChatConversation(db, userId, "你好", sid(), { model: llm.model });
    const r = cycleChatGreeting(db, userId, sid());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("已经开始了");
  });
});

describe("P9 冒险者卡", () => {
  it("保存与读取；渲染成提示词层", () => {
    expect(getUserPersona(db)).toEqual({ name: "", brief: "", description: "" });
    setUserPersona(db, { name: "阿岚", brief: "夜班程序员", description: "想重新开始" });
    const p = getUserPersona(db);
    expect(p.name).toBe("阿岚");
    const layer = buildUserPersonaLayer(p);
    expect(layer).toContain("【关于这位冒险者");
    expect(layer).toContain("称呼：阿岚");
    expect(layer).toContain("夜班程序员");
  });

  it("空设置渲染成空串（整层省略）", () => {
    expect(buildUserPersonaLayer(getUserPersona(db))).toBe("");
  });

  it("两个模式都注入冒险者卡", async () => {
    setUserPersona(db, { name: "阿岚", brief: "夜班程序员" });
    const llm = new ScriptedModel([text("嗯。")]);
    await runChatConversation(db, userId, "在吗", sid(), { model: llm.model });
    expect(llm.calls[0].system).toContain("称呼：阿岚");
  });
});

describe("P9 世界书 token 预算", () => {
  it("estimateTokens 单调；常驻与全量可分别统计", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(50);

    const book = createBook(db, userId, "预算书");
    replaceBookEntries(db, userId, book, [
      { keys: [], content: "常驻内容".repeat(10), constant: true },
      { keys: ["x"], content: "关键词内容".repeat(20), constant: false },
    ]);
    assignBook(db, userId, "master_vila", book);
    const entries = listBookEntries(db, userId, book);
    const constantTokens = entries
      .filter((e) => e.constant)
      .reduce((s, e) => s + estimateTokens(e.content), 0);
    const totalTokens = entries.reduce((s, e) => s + estimateTokens(e.content), 0);
    expect(constantTokens).toBeGreaterThan(0);
    expect(totalTokens).toBeGreaterThan(constantTokens);
  });
});
