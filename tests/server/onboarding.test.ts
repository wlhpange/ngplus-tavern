import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../llm/helpers";
import { isOnboarded, markOnboarded } from "../../src/server/masters";
import { saves } from "../../src/server/db/schema";
import { loadPromptContext } from "../../src/server/llm/conversation";
import { buildSystemPrompt, buildOnboardingLayer } from "../../src/server/llm/prompts";
import { VILA_PERSONA } from "../../src/server/db/seed";

describe("冷启动标记流转（M5 三幕）", () => {
  it("新用户未完成冷启动（onboarded_at 为空）", () => {
    const { db, userId } = createTestDb();
    expect(isOnboarded(db, userId)).toBe(false);
    expect(db.select().from(saves).where(eq(saves.userId, userId)).get()!.onboardedAt).toBeNull();
  });

  it("markOnboarded 落库且幂等；二次调用返回 false 但不改时间戳", () => {
    const { db, userId } = createTestDb();
    const t = 1_760_000_000_000;
    expect(markOnboarded(db, userId, t)).toBe(true);
    expect(isOnboarded(db, userId)).toBe(true);
    expect(
      db.select().from(saves).where(eq(saves.userId, userId)).get()!.onboardedAt,
    ).toBe(t);

    expect(markOnboarded(db, userId, t + 9999)).toBe(false);
    expect(
      db.select().from(saves).where(eq(saves.userId, userId)).get()!.onboardedAt,
    ).toBe(t);
  });

  it("无存档用户 markOnboarded 返回 false，不抛错", () => {
    const { db } = createTestDb();
    expect(markOnboarded(db, "ghost")).toBe(false);
    expect(isOnboarded(db, "ghost")).toBe(false);
  });
});

describe("冷启动剧本注入（onboarding-script.md §4 第三幕）", () => {
  it("未完成冷启动 → loadPromptContext.isOnboarding=true，系统提示词含第三幕", () => {
    const { db, userId } = createTestDb();
    const ctx = loadPromptContext(db, userId);
    expect(ctx.isOnboarding).toBe(true);

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("第一次见面");
    expect(prompt).toContain("想做却一直没做成");
    expect(prompt).toContain("create_quest");
    // 骨架层铁律仍在（人设滤镜不越权）
    expect(prompt).toContain("你无权在文本中声明任何数值变更");
    // 层序：骨架 → 冷启动 → 人设
    expect(prompt.indexOf("第一次见面")).toBeGreaterThan(
      prompt.indexOf("你是「二周目协会」的会长"),
    );
    expect(prompt.indexOf("【你的人设】")).toBeGreaterThan(
      prompt.indexOf("第一次见面"),
    );
  });

  it("完成冷启动后 isOnboarding=false，提示词不含第三幕（长期提示词保持干净）", () => {
    const { db, userId } = createTestDb();
    markOnboarded(db, userId);
    const ctx = loadPromptContext(db, userId);
    expect(ctx.isOnboarding).toBe(false);
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("第一次见面");
    expect(prompt).not.toContain("想做却一直没做成");
  });

  it("第三幕层本身包含节拍表要点：最多一件委托、三个候选", () => {
    const s = buildOnboardingLayer("薇拉");
    expect(s).toContain("最多只挂一件委托");
    expect(s).toContain("23:30 前熄灯");
    expect(s).toContain("不做导览");
    // 通知功能已下线：第三幕不再约定晚间汇报时间
    expect(s).not.toContain("几点得空");
  });

  it("人格卡自带 sample_dialogues 与冷启动层并存（few-shot 不被覆盖）", () => {
    const { db, userId } = createTestDb();
    const ctx = loadPromptContext(db, userId);
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain(VILA_PERSONA.sample_dialogues[0].text);
    expect(prompt).toContain("【语气样例");
  });
});
