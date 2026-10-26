import { describe, it, expect } from "vitest";

import { buildChatPrompt } from "../../src/server/llm/prompts";

const base = {
  masterName: "薇拉",
  persona: { description: "协会的会长，话不多。" },
  memories: [],
  userPersona: "",
  userName: "旅人",
};

describe("聊天提示词 · R18 开关", () => {
  it("关闭时不注入解禁准则与 2k–5k 篇幅规则", () => {
    const off = buildChatPrompt({ ...base, adultContent: false });
    expect(off).not.toContain("IMPORTANT ROLE-PLAY GUIDELINE");
    expect(off).not.toContain("2,000 to 5,000 Chinese characters");
    // 演出层仍在：R18 只是内容尺度，不影响正常 RP
    expect(off).toContain("不必刻意简短");
  });

  it("打开时同时注入解禁准则和篇幅规则", () => {
    const on = buildChatPrompt({ ...base, adultContent: true });
    expect(on).toContain("IMPORTANT ROLE-PLAY GUIDELINE");
    expect(on).toContain("2,000 to 5,000 Chinese characters");
    expect(on).toContain("<general-rules>");
    expect(on).toContain("薇拉");
  });

  it("世界书 / 记忆与 R18 互不影响", () => {
    const text = buildChatPrompt({
      ...base,
      adultContent: true,
      memories: [{ category: "goal", content: "想在协会开一间自己的房间" }],
      worldInfoBefore: "【世界书】北境的雪季很长。",
    });
    expect(text).toContain("想在协会开一间自己的房间");
    expect(text).toContain("北境的雪季很长");
    expect(text).toContain("2,000 to 5,000 Chinese characters");
  });
});
