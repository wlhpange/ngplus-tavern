import { describe, expect, it } from "vitest";
import { buildMemoryLayer } from "../../src/server/llm/prompts";
import { MEMORY_CATEGORY_LABELS, isMemoryCategory } from "../../src/server/memory";

describe("记忆注入提示词", () => {
  it("无记忆时不产生记忆层", () => {
    expect(buildMemoryLayer([])).toBe("");
  });

  it("按类别聚合并用中文标签，多条同类别合并", () => {
    const text = buildMemoryLayer([
      { category: "preference", content: "怕冷" },
      { category: "preference", content: "喜欢热茶" },
    ]);
    expect(text).toContain("【你记得的关于这位冒险者的事】");
    expect(text).toContain("偏好：「怕冷」、「喜欢热茶」");
  });

  it("按 goal > preference/relationship > profile/story > event 排序", () => {
    const text = buildMemoryLayer([
      { category: "event", content: "跑完第一趟" },
      { category: "profile", content: "夜班程序员" },
      { category: "relationship", content: "叫我会长" },
      { category: "goal", content: "想早睡" },
    ]);
    const order = ["目标：", "关系：", "画像：", "事件："].map((k) => text.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("未知类别原样输出，不丢失内容", () => {
    expect(buildMemoryLayer([{ category: "custom", content: "自定义" }])).toContain("custom：「自定义」");
  });
});

describe("记忆类别常量", () => {
  it("六类记忆均有中文名，非法类别被拒绝", () => {
    for (const key of ["profile", "preference", "event", "goal", "story", "relationship"]) {
      expect(isMemoryCategory(key)).toBe(true);
      expect(MEMORY_CATEGORY_LABELS[key]).toBeTruthy();
    }
    expect(isMemoryCategory("unknown")).toBe(false);
    expect(isMemoryCategory("")).toBe(false);
  });
});
