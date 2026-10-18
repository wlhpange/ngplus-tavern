import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  needsTranslation,
  translateText,
  translateBatch,
  translateImportedCard,
  translationPreview,
  countForeignPersonaFields,
  countForeignBookEntries,
} from "../../src/server/translate";
import type { ImportedCard } from "../../src/server/cardImport";

const SEP = "<<<===>>>";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? (p as { text?: string }).text ?? "" : ""))
      .join("");
  }
  return "";
}
function userText(o: LanguageModelV4CallOptions): string {
  return o.prompt.filter((m) => m.role === "user").map((m) => partText(m.content)).join("\n");
}
function sysText(o: LanguageModelV4CallOptions): string {
  return o.prompt.filter((m) => m.role === "system").map((m) => partText(m.content)).join("\n");
}

/** 文本模型：批处理（含分隔符）逐段翻译；单段直接加前缀 */
class FlexModel {
  readonly model: LanguageModel;
  calls: { system: string; user: string }[] = [];
  constructor(private single = (s: string) => `[译]${s}`) {
    this.model = new MockLanguageModelV4({
      doGenerate: async (o: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
        const user = userText(o);
        this.calls.push({ system: sysText(o), user });
        let reply: string;
        if (user.includes(SEP)) {
          const body = user.slice(user.indexOf("\n\n") + 2);
          const segs = body.split(SEP).map((s) => s.trim());
          reply = segs.map((s) => `T:${s}`).join(`\n${SEP}\n`);
        } else {
          reply = this.single(user);
        }
        return {
          content: [{ type: "text", text: reply }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    }) as unknown as LanguageModel;
  }
}

describe("P11 needsTranslation", () => {
  it("英文需要翻译；中文不需要；纯符号/空不需要", () => {
    expect(needsTranslation("Hello, I am Seraphina.")).toBe(true);
    expect(needsTranslation("你好，我是塞拉菲娜。")).toBe(false);
    expect(needsTranslation("")).toBe(false);
    expect(needsTranslation("12345 ……")).toBe(false);
    expect(needsTranslation("{{user}}: hi")).toBe(true);
  });
});

describe("P11 translateText", () => {
  it("忠实翻译；系统提示含不审查与保留格式铁律", async () => {
    const m = new FlexModel(() => "你好，我是薇拉。");
    const out = await translateText(m.model, "Hello, I am Vila.");
    expect(out).toBe("你好，我是薇拉。");
    const sys = m.calls[0].system;
    expect(sys).toContain("人名、地名、专有名词保持原文");
    expect(sys).toContain("不回避、不审查、不淡化");
    expect(sys).toContain("{{user}}/{{char}}");
  });

  it("中文文本不调用模型，原样返回", async () => {
    const m = new FlexModel();
    const out = await translateText(m.model, "这已经是中文了");
    expect(out).toBe("这已经是中文了");
    expect(m.calls).toHaveLength(0);
  });

  it("模型返回空时保留原文", async () => {
    const m = new FlexModel(() => "");
    expect(await translateText(m.model, "Hello")).toBe("Hello");
  });
});

describe("P11 translateBatch", () => {
  it("条数与顺序一致时逐条替换", async () => {
    const m = new FlexModel();
    const out = await translateBatch(m.model, ["one", "two", "three"]);
    expect(out).toEqual(["T:one", "T:two", "T:three"]);
  });

  it("条数不一致时保留原文（防串位）", async () => {
    // 直接返回不含分隔符的内容 → split 后只有 1 段 → 保留原文
    const model = new MockLanguageModelV4({
      doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
        content: [{ type: "text", text: "只有一段" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
    }) as unknown as LanguageModel;
    const out = await translateBatch(model, ["a", "b", "c"]);
    expect(out).toEqual(["a", "b", "c"]);
  });
});

describe("P11 translateImportedCard", () => {
  const card: ImportedCard = {
    name: "Seraphina",
    spec: "v2",
    persona: {
      description: "A gentle forest guardian.",
      first_mes: "You wake up.",
      personality: ["caring", "protective"],
      alternate_greetings: ["Hello there."],
    },
    characterBook: {
      entries: [
        { keys: ["eldoria", "forest"], content: "Eldoria is a magical forest.", secondary_keys: [] },
      ],
    },
  };

  it("翻译 persona 字段 + 世界书内容，并保留原文关键词（并集）", async () => {
    const m = new FlexModel();
    const r = await translateImportedCard(m.model, card);
    expect(r.translatedFields).toBeGreaterThan(0);
    expect(r.translatedEntries).toBe(1);
    expect(r.card.persona.description).toBe("[译]A gentle forest guardian.");
    expect(r.card.name).toBe("Seraphina"); // 名字不动
    const book = r.card.characterBook as { entries: { keys: string[]; content: string }[] };
    expect(book.entries[0].content).toBe("T:Eldoria is a magical forest.");
    // 关键词保留原文并追加译文
    expect(book.entries[0].keys).toContain("eldoria");
    expect(book.entries[0].keys.length).toBeGreaterThan(2);
  });

  it("translationPreview：外语卡 needed=true 并给出计数", () => {
    const pv = translationPreview(card);
    expect(pv.needed).toBe(true);
    expect(pv.fields).toBeGreaterThan(0);
    expect(pv.entries).toBe(1);
    expect(countForeignPersonaFields(card.persona)).toBeGreaterThan(0);
    expect(countForeignBookEntries(card.characterBook)).toBe(1);
  });

  it("纯中文卡 needed=false", () => {
    const cn: ImportedCard = {
      name: "薇拉",
      spec: "v1",
      persona: { description: "一个爽朗的会长。", first_mes: "哟，来了。" },
      characterBook: null,
    };
    expect(translationPreview(cn).needed).toBe(false);
  });

  it("进度回调：从 0 到 total，最终 done === total", async () => {
    const m = new FlexModel();
    const events: [number, number][] = [];
    await translateImportedCard(m.model, card, {
      onProgress: (done, total) => events.push([done, total]),
    });
    // 首次为 (0,total)
    expect(events[0][0]).toBe(0);
    const total = events[0][1];
    expect(total).toBeGreaterThan(0);
    // 最后一次 done === total
    expect(events[events.length - 1][0]).toBe(total);
    // done 单调不减
    for (let i = 1; i < events.length; i++) {
      expect(events[i][0]).toBeGreaterThanOrEqual(events[i - 1][0]);
    }
  });

  it("shouldStop=true 时抛取消异常且不落库", async () => {
    const m = new FlexModel();
    await expect(
      translateImportedCard(m.model, card, { shouldStop: () => true }),
    ).rejects.toThrow(/取消/);
  });
});
