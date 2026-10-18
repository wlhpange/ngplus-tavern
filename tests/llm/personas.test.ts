import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type PromptContext } from "../../src/server/llm/prompts";
import { OFFICIAL_MASTERS } from "../../src/server/db/seed";
import type { CharacterSummary } from "../../src/server/character";

/**
 * M4 验收关键点：同一上下文分别用四个人格组装系统提示词，
 * 样例层与语气必须可区分——断言四份 prompt 两两互不相同的比例为 100%。
 */

const characterFixture: CharacterSummary = {
  userId: "u1",
  totalXp: 200,
  totalLevel: 2,
  xpToNextLevel: 50,
  nextLevelXpRequired: 250,
  rank: "F",
  gold: 42,
  attrs: {
    vitality: { xp: 10, level: 1, xpToNext: 140 },
    mind: { xp: 100, level: 1, xpToNext: 50 },
    willpower: { xp: 0, level: 1, xpToNext: 150 },
    wealth: { xp: 0, level: 1, xpToNext: 150 },
    social: { xp: 0, level: 1, xpToNext: 150 },
    creativity: { xp: 0, level: 1, xpToNext: 150 },
  },
  titles: [],
};

function ctxFor(name: string, persona: PromptContext["persona"]): PromptContext {
  return {
    masterName: name,
    persona,
    intimacyStage: 1,
    memories: [{ category: "goal", content: "今年背完 3000 单词" }],
    activeQuests: [
      { title: "每天背单词", type: "daily", status: "active", streak: 3, difficulty: 1 },
    ],
    character: characterFixture,
    todaySettlements: [],
  };
}

const promptsByName = new Map(
  OFFICIAL_MASTERS.map((m) => [
    m.name,
    { name: m.name, prompt: buildSystemPrompt(ctxFor(m.name, m.persona)) },
  ]),
);

describe("四人格 prompt 可区分性", () => {
  it("四位官方会长各一份 prompt，阵容与文档 §8 一致", () => {
    expect([...promptsByName.keys()].sort()).toEqual(
      ["薇拉", "加洛", "莱恩", "墨"].sort(),
    );
  });

  it("四份系统提示词两两互不相同（6/6 对）", () => {
    const entries = [...promptsByName.values()];
    let distinct = 0;
    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        total++;
        if (entries[i].prompt !== entries[j].prompt) distinct++;
      }
    }
    expect(total).toBe(6);
    expect(distinct / total).toBe(1);
  });

  it("每份 prompt 含本人格口头禅与样例，且锚定风格行为可区分（文档 §2 表格）", () => {
    // 骨架层一致（同一份铁律），人设层/样例层各自带风格锚点
    const vila = promptsByName.get("薇拉")!.prompt;
    expect(vila).toContain("口头禅：哟、好家伙");
    expect(vila).toContain("哟，醒了？");
    expect(vila).toContain("「新面孔」");

    const galo = promptsByName.get("加洛")!.prompt;
    expect(galo).toContain("多久。具体数字。");
    expect(galo).toContain("别用'大概'");
    expect(galo).toContain("「新兵」");

    const lain = promptsByName.get("莱恩")!.prompt;
    expect(lain).toContain("等等，这段得记下来");
    expect(lain).toContain("我亲爱的主角");
    expect(lain).toContain("细节是史诗的灵魂");

    const mo = promptsByName.get("墨")!.prompt;
    expect(mo).toContain("口头禅：数据。、嗯。");
    expect(mo).toContain("昨天断在哪，想过吗。");

    // 风格锚点互串检查：加洛的口令不出现在墨的 prompt 里
    expect(mo).not.toContain("多久。具体数字。");
    expect(galo).not.toContain("史诗的灵魂");
    expect(vila).not.toContain("口头禅：数据。");
    expect(lain).not.toContain("别飘。");
  });

  it("骨架层对四人格完全一致（规则与风格无关）", () => {
    const skeleton = (p: string) => p.split("\n\n")[0];
    const skeletons = [...promptsByName.values()].map((e) =>
      skeleton(e.prompt).replaceAll(e.name, "{NAME}"),
    );
    for (const s of skeletons) expect(s).toBe(skeletons[0]);
  });
});
