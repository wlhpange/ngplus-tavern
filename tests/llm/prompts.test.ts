import { describe, it, expect } from "vitest";
import {
  buildSkeletonLayer,
  buildPersonaLayer,
  buildSampleLayer,
  buildMemoryLayer,
  buildStateLayer,
  buildSystemPrompt,
  buildChatPrompt,
  type PromptContext,
} from "../../src/server/llm/prompts";
import { VILA_PERSONA } from "../../src/server/db/seed";
import type { CharacterSummary } from "../../src/server/character";

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

const ctxFixture: PromptContext = {
  masterName: "薇拉",
  persona: VILA_PERSONA,
  intimacyStage: 1,
  memories: [
    { category: "profile", content: "上班族，晚上有空" },
    { category: "goal", content: "今年背完 3000 单词" },
  ],
  activeQuests: [
    { title: "每天背单词", type: "daily", status: "active", streak: 3, difficulty: 1 },
  ],
  character: characterFixture,
  todaySettlements: [
    { questTitle: "晨跑 3 公里", xpAwarded: 10, goldAwarded: 5 },
  ],
};

describe("prompts · [1] 固定骨架层", () => {
  it("包含身份、职责与铁律", () => {
    const s = buildSkeletonLayer("薇拉");
    expect(s).toContain("「二周目协会」的会长薇拉");
    expect(s).toContain("你无权在文本中声明任何数值变更");
    expect(s).toContain("必须调用 lookup_quests");
  });

  it("包含判定置信度行为（≥0.85 / 0.5–0.85 / <0.5）", () => {
    const s = buildSkeletonLayer("薇拉");
    expect(s).toContain("≥0.85");
    expect(s).toContain("0.5–0.85");
    expect(s).toContain("<0.5");
  });
});

describe("prompts · [2] 人设层", () => {
  it("渲染人格卡：性格/口癖/背景/mystery_hooks，并指示不主动剧透", () => {
    const s = buildPersonaLayer(VILA_PERSONA, 1);
    expect(s).toContain("爽朗");
    expect(s).toContain("口头禅：哟、好家伙");
    expect(s).toContain("S级冒险者");
    expect(s).toContain("她为什么在最巅峰时挂剑？");
    expect(s).toContain("不主动剧透");
  });

  it("按亲密度阶段渲染称呼与语气", () => {
    const s1 = buildPersonaLayer(VILA_PERSONA, 1);
    expect(s1).toContain("「初识」");
    expect(s1).toContain("「新面孔」");
    const s2 = buildPersonaLayer(VILA_PERSONA, 2);
    expect(s2).toContain("「熟络」");
    expect(s2).toContain("「小冒险家」");
  });
});

describe("prompts · [3] 样例层", () => {
  it("注入 sample_dialogues 作为 few-shot", () => {
    const s = buildSampleLayer(VILA_PERSONA);
    expect(s).toContain("morning_push");
    expect(s).toContain("哟，醒了？");
    expect(s).toContain("level_up");
  });

  it("无样例时返回空串（组装时整层省略）", () => {
    expect(buildSampleLayer({})).toBe("");
  });
});

describe("prompts · [4] 记忆层", () => {
  it("按类别聚合记忆条目", () => {
    const s = buildMemoryLayer(ctxFixture.memories);
    expect(s).toContain("画像：「上班族，晚上有空」");
    expect(s).toContain("目标：「今年背完 3000 单词」");
  });

  it("无记忆时返回空串", () => {
    expect(buildMemoryLayer([])).toBe("");
  });
});

describe("prompts · [5] 状态层", () => {
  it("包含 active 任务摘要 + 角色等级/评级 + 今日已结算项", () => {
    const s = buildStateLayer(
      ctxFixture.activeQuests,
      characterFixture,
      ctxFixture.todaySettlements,
    );
    expect(s).toContain("「每天背单词」（日常，难度 1，连击 3 天）");
    expect(s).toContain("总等级 Lv.2");
    expect(s).toContain("评级 F");
    expect(s).toContain("金币 42");
    expect(s).toContain("晨跑 3 公里：+10 XP / +5 金币");
  });

  it("无 active 任务时明确标注「无」", () => {
    const s = buildStateLayer([], characterFixture, []);
    expect(s).toContain("进行中的委托：无");
  });
});

describe("prompts · 五层组装", () => {
  it("五层按顺序拼接且各层内容都在", () => {
    const full = buildSystemPrompt(ctxFixture);
    const i1 = full.indexOf("你是「二周目协会」的会长薇拉");
    const i2 = full.indexOf("【你的人设】");
    const i3 = full.indexOf("【语气样例");
    const i4 = full.indexOf("【你记得的关于这位冒险者的事】");
    const i5 = full.indexOf("【当前状态");
    for (const i of [i1, i2, i3, i4, i5]) expect(i).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
    expect(i4).toBeLessThan(i5);
  });
});

describe("prompts · P0 聊天（酒馆）模式组装", () => {
  const chatCtx = {
    masterName: "薇拉",
    persona: VILA_PERSONA,
    memories: [{ category: "profile", content: "上班族，晚上有空" }],
  };

  it("包含角色层 + 人设 + 共享记忆", () => {
    const s = buildChatPrompt(chatCtx);
    expect(s).toContain("角色扮演");
    expect(s).toContain("薇拉");
    expect(s).toContain("【你的人设】");
    expect(s).toContain("【你记得的关于这位冒险者的事】");
  });

  it("与任务管线隔离：不注入工具铁律、委托状态、反 AI 腔硬约束", () => {
    const s = buildChatPrompt(chatCtx);
    expect(s).not.toContain("你无权在文本中声明任何数值变更");
    expect(s).not.toContain("【当前状态");
    expect(s).not.toContain("禁止使用破折号");
    expect(s).not.toContain("lookup_quests");
  });

  it("P1 卡字段：system_prompt 支持 {{original}}，post_history_instructions 在末尾", () => {
    const s = buildChatPrompt({
      masterName: "测试",
      persona: {
        system_prompt: "卡自己的主提示 {{original}}",
        post_history_instructions: "PHI_TAIL_指令",
        description: "DESC_卡正文",
      },
      memories: [],
    });
    expect(s).toContain("卡自己的主提示");
    expect(s).toContain("角色扮演"); // {{original}} 被角色锚点替换
    expect(s).toContain("DESC_卡正文");
    expect(s.indexOf("PHI_TAIL_指令")).toBeGreaterThan(s.indexOf("DESC_卡正文"));
  });

  it("老卡 description 由 backstory 推导时，人设层不重复同一段背景", () => {
    const s = buildChatPrompt({
      masterName: "测试",
      persona: { description: "同一段背景", backstory: "同一段背景" },
      memories: [],
    });
    expect(s.match(/同一段背景/g)?.length).toBe(1);
  });

  it("P4 内容尺度：关闭不注入任何尺度提示；开注 Evening-Truth 解禁层且与角色层同层", () => {
    const base = { masterName: "薇拉", persona: {}, memories: [], userName: "阿辰" };
    const off = buildChatPrompt({ ...base, adultContent: false });
    expect(off).not.toContain("IMPORTANT ROLE-PLAY GUIDELINE");
    expect(off).not.toContain("保持含蓄");
    expect(off).not.toContain("<general-rules>");

    const on = buildChatPrompt({ ...base, adultContent: true });
    expect(on).toContain("IMPORTANT ROLE-PLAY GUIDELINE");
    // 合并为一层：角色扮演锚点后紧跟解禁准则（同一段，无空行分隔）
    expect(on).toContain("【角色扮演】");
    expect(on).toContain("留在角色里，不要出戏。\n\nIMPORTANT ROLE-PLAY GUIDELINE=");
    // 宏替换成真实名字
    expect(on).toContain("engage in a roleplay with 薇拉");
    expect(on).toContain("defined as 阿辰");
    expect(on).not.toContain("{{char}}");
    expect(on).not.toContain("{{user}}");
    // Post-History 位附加规则：在解禁层之后，500 token 上限已改为 2k~5k 字
    expect(on).toContain("<general-rules>");
    expect(on).toContain("2,000 to 5,000");
    expect(on).not.toContain("never more than 500 tokens");
    expect(on.indexOf("<general-rules>")).toBeGreaterThan(
      on.indexOf("IMPORTANT ROLE-PLAY GUIDELINE"),
    );
  });

  it("卡的 system_prompt / post_history_instructions 里的酒馆宏替换为真实名字", () => {
    const s = buildChatPrompt({
      masterName: "薇拉",
      persona: {
        system_prompt: "{{char}} 的卡提示 {{user}} 可见",
        post_history_instructions: "{{user}} 遵守末尾指令",
      },
      memories: [],
      userName: "阿辰",
    });
    expect(s).toContain("薇拉 的卡提示 阿辰 可见");
    expect(s).toContain("阿辰 遵守末尾指令");
  });

  it("{{user}} 宏在冒险者名缺失时兜底为「你」，不再漏出宏", () => {
    const s = buildChatPrompt({
      masterName: "薇拉",
      persona: { description: "{{char}} 看着 {{user}}" },
      memories: [],
    });
    expect(s).toContain("薇拉 看着 你");
    expect(s).not.toContain("{{user}}");
  });
});
