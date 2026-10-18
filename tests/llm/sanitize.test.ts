import { describe, it, expect } from "vitest";
import { sanitizeReply } from "../../src/server/llm/conversation";

describe("sanitizeReply · 反 AI 腔后处理", () => {
  it("破折号替换为句号", () => {
    expect(sanitizeReply("你说想读书——这很好——但关键在于坚持。")).toBe(
      "你说想读书。这很好。但关键在于坚持。",
    );
  });

  it("清除 markdown 粗体", () => {
    expect(sanitizeReply("**今日战果**：经验 +12")).toBe("今日战果：经验 +12");
  });

  it("清除行首列表符号（保留朴素编号）", () => {
    expect(sanitizeReply("完成了。\n- 时长 40 分钟\n- 数量 52 个")).toBe(
      "完成了。\n时长 40 分钟\n数量 52 个",
    );
    expect(sanitizeReply("1. 先睡\n2. 再跑")).toContain("1. 先睡");
  });

  it("清除 markdown 标题", () => {
    expect(sanitizeReply("# 战果报告\n\n跑了 5 公里。")).toBe("战果报告\n\n跑了 5 公里。");
  });

  it("清除 emoji 装饰", () => {
    expect(sanitizeReply("干得漂亮！✨💪 明天继续。")).toBe("干得漂亮！ 明天继续。");
  });

  it("奖励数值被清洗（V1.7：会长不许报数），普通数字不误伤", () => {
    const scrubbed = sanitizeReply("记上了，+10 XP，+5 金币。第 1 天，先这样。");
    expect(scrubbed).not.toContain("10 XP");
    expect(scrubbed).not.toContain("5 金币");
    expect(scrubbed).toContain("第 1 天");
    // 汉字数字与普通数量词不受影响
    const good = "背了 50 个单词，读了三章。第 1 天，先这样。";
    expect(sanitizeReply(good)).toBe(good);
    // 属性数值与 Lv 泄漏
    expect(sanitizeReply("体魄 +12，意志 +7")).not.toContain("+12");
    expect(sanitizeReply("你都 Lv.5 了")).not.toMatch(/Lv.?s*5/);
  });
});
