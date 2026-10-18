import { describe, it, expect } from "vitest";
import { normalizeCard, parseCard, deriveGreeting, greetingCount } from "../../src/server/cards";
import { VILA_PERSONA } from "../../src/server/db/seed";

describe("P1 会长卡 v1 · normalizeCard", () => {
  it("老卡（只有 backstory/self_intro/sample_dialogues）→ 推导出 description/first_mes/mes_example", () => {
    const old = {
      self_intro: "哟，新面孔。",
      backstory: "传说她曾是S级冒险者。",
      sample_dialogues: [{ scene: "morning", text: "醒了？" }],
    };
    const c = normalizeCard(old);
    expect(c.description).toBe("传说她曾是S级冒险者。");
    expect(c.first_mes).toBe("哟，新面孔。");
    expect(c.mes_example).toContain("醒了？");
    expect(c.tags).toEqual([]);
    expect(c.alternate_greetings).toEqual([]);
  });

  it("新卡字段优先，不被兜底覆盖", () => {
    const c = normalizeCard({
      description: "正式的卡正文",
      backstory: "旧的背景",
      first_mes: "正式开场白",
      self_intro: "旧的推介",
      alternate_greetings: ["备选一", ""],
      tags: ["官方", "会长"],
    });
    expect(c.description).toBe("正式的卡正文");
    expect(c.first_mes).toBe("正式开场白");
    expect(c.alternate_greetings).toEqual(["备选一"]); // 空串被过滤
    expect(c.tags).toEqual(["官方", "会长"]);
  });

  it("不销毁未知字段（CC 规范 MUST NOT destroy）", () => {
    const c = normalizeCard({
      description: "x",
      character_book: { name: "卡内世界书", entries: [] },
      extensions: { "vendor/foo": 1 },
      creator: "someone",
    });
    expect((c.character_book as { name: string }).name).toBe("卡内世界书");
    expect(c.extensions).toEqual({ "vendor/foo": 1 });
    expect(c.creator).toBe("someone");
  });

  it("parseCard 对坏 JSON 不抛错，返回空卡", () => {
    expect(parseCard("{not json")).toMatchObject({ tags: [], alternate_greetings: [] });
    expect(parseCard(JSON.stringify(VILA_PERSONA)).description).toContain("薇拉");
  });
});

describe("P1 会长卡 v1 · 开场白推导", () => {
  it("index=0 取 first_mes，依次取 alternate_greetings", () => {
    const card = normalizeCard({
      first_mes: "第一句",
      alternate_greetings: ["第二句", "第三句"],
    });
    expect(deriveGreeting(card, "薇拉", 0)).toBe("第一句");
    expect(deriveGreeting(card, "薇拉", 1)).toBe("第二句");
    expect(deriveGreeting(card, "薇拉", 2)).toBe("第三句");
    // 越界回退到最后一条
    expect(deriveGreeting(card, "薇拉", 9)).toBe("第三句");
    expect(greetingCount(card)).toBe(3);
  });

  it("没有开场白时用中性兜底（带会长名字，不含具体人设）", () => {
    const card = normalizeCard({ backstory: "只有背景" });
    expect(deriveGreeting(card, "墨")).toContain("墨");
    expect(greetingCount(card)).toBe(0);
  });
});
