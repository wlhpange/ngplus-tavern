import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * 会长人格卡锻造：schema 与「按已填字段补全」的生成入口。
 *
 * V2.0：新增会长不再要求单独写一段「描述」——用户在名字 / 描述 / 性格 / 场景 /
 * 开场白 / 标签里随便填哪几项，就按哪几项把其余的补全（见 /api/masters/forge）。
 *
 * 说明：forge 走 generateText + JSON 解析，而不是结构化输出（generateObject）——
 * 本地 LLM（LM Studio / llama.cpp 等）大多不支持 responseFormat，结构化输出会直接
 * 报错；这与 server/translate.ts 的选择一致（跨供应商更稳）。缺字段/超长由
 * normalizeForged 兜底收敛，落库时再由 create 路由用表单值覆盖。
 */

/** 人格核心字段（不含名字；指名邀请的名字由调用方给出） */
const personaCore = {
  self_intro: z.string().max(80),
  personality: z.array(z.string().max(20)).max(6),
  speech: z.object({
    catchphrases: z.array(z.string().max(16)).max(3),
    address_user: z.string().max(12),
    verbosity: z.string().max(20),
    formality: z.string().max(20),
    quirks: z.string().max(40),
    voice: z.string().max(120),
  }),
  backstory: z.string().max(300),
  mystery_hooks: z.array(z.string().max(60)).max(3),
  // P1 会长卡 v1：卡正文与开场白（对齐 Character Card V2/V3 子集）
  description: z.string().max(400).optional(),
  scenario: z.string().max(200).optional(),
  first_mes: z.string().max(200).optional(),
  alternate_greetings: z.array(z.string().max(200)).max(2).optional(),
  tags: z.array(z.string().max(12)).max(4).optional(),
  sample_dialogues: z
    .array(z.object({ scene: z.string().max(20), text: z.string().max(120) }))
    .max(4),
  // V2.0 修复：锻造提示词一直要求输出关系阶段，但此前 schema 未声明导致被丢弃；
  // 可选项（漏给/给不全时由 normalizeRelationshipStages 用默认补齐）
  relationship_stages: z
    .array(
      z.object({
        stage: z.number().int().min(1).max(3),
        label: z.string().max(12),
        address: z.string().max(12),
        tone_note: z.string().max(60),
      }),
    )
    .max(3)
    .optional(),
} as const;

/** 「指名邀请」用：名字由调用方给出，结构化输出只有人格内容 */
export const PersonaForgeSchema = z.object(personaCore);

/** forge 的宽松结果形态（文本 JSON 解析后收敛；字段都可缺省） */
export interface ForgedCard {
  name?: string;
  self_intro?: string;
  personality?: string[];
  speech?: {
    catchphrases?: string[];
    address_user?: string;
    verbosity?: string;
    formality?: string;
    quirks?: string;
    voice?: string;
  };
  backstory?: string;
  mystery_hooks?: string[];
  description?: string;
  scenario?: string;
  first_mes?: string;
  alternate_greetings?: string[];
  tags?: string[];
  sample_dialogues?: { scene: string; text: string }[];
  relationship_stages?: { stage: number; label: string; address: string; tone_note: string }[];
}

export interface ForgeFieldsInput {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  tags?: string;
}

const FORGE_SYSTEM = [
  "你是「二周目协会」的人格锻造师。用户想新增一位会长，但只填了部分字段，",
  "你根据用户已填的内容，补全一张可直接使用的会长人格卡。",
  "世界观：二周目协会是一间专为「想重新开始的人生」服务的小协会，会长像朋友而非客服，",
  "身上带一点未解的谜。性格要鲜明、有缺口，不要完美圣人。",
  "所有文字用中文；每段都简洁（描述、来历各 2–3 句，其余一句话）。",
  "relationship_stages 固定三档（stage 1/2/3），给出每档的 label（阶段名，可以按角色风格另起）、address（怎么称呼用户）与 tone_note（语气要点）。",
  "description 是一段 2–3 句的人物速写（别人眼中的 ta）；scenario 是一句「此刻你们在哪里、在做什么」的场景设定；",
  "first_mes 是 ta 见到用户时说的第一句话（1–2 句，要有角色的味道，不要问候模板）；tags 给 1–3 个短标签。",
  "name 若用户没给，请起一个 2–6 字、有记忆点的名字；用户若已给出名字必须原样沿用。",
  "只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释或前后缀。",
].join("\n");

const JSON_SHAPE = `{
  "name": "会长名字",
  "self_intro": "一句话自我推介",
  "personality": ["性格关键词", "2–4 个"],
  "description": "人物速写（2–3 句）",
  "scenario": "此刻你们在哪里、在做什么",
  "first_mes": "见到用户说的第一句话",
  "tags": ["标签", "1–3 个"],
  "backstory": "来历（2–3 句）",
  "mystery_hooks": ["未解之谜"],
  "alternate_greetings": ["备选开场白"],
  "relationship_stages": [
    { "stage": 1, "label": "阶段名", "address": "称呼", "tone_note": "语气要点" },
    { "stage": 2, "label": "阶段名", "address": "称呼", "tone_note": "语气要点" },
    { "stage": 3, "label": "阶段名", "address": "称呼", "tone_note": "语气要点" }
  ]
}`;

/** 从可能夹带解释/代码围栏的文本里抠出 JSON 对象 */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/** 文本 JSON → 收敛成安全的 ForgedCard（截断超长、过滤脏值） */
function normalizeForged(raw: unknown): ForgedCard {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const s = (v: unknown, max: number): string | undefined => {
    const t = typeof v === "string" ? v.trim() : "";
    return t ? t.slice(0, max) : undefined;
  };
  const list = (v: unknown, maxItems: number, maxLen: number): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, maxItems)
      .map((x) => x.trim().slice(0, maxLen));
    return out.length ? out : undefined;
  };
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};

  const sp = rec(o.speech);
  const speech: NonNullable<ForgedCard["speech"]> = {
    catchphrases: list(sp.catchphrases, 3, 16),
    address_user: s(sp.address_user, 12),
    verbosity: s(sp.verbosity, 20),
    formality: s(sp.formality, 20),
    quirks: s(sp.quirks, 40),
    voice: s(sp.voice, 120),
  };
  const hasSpeech = Object.values(speech).some((v) => v !== undefined);

  const relationship_stages = Array.isArray(o.relationship_stages)
    ? o.relationship_stages
        .map(rec)
        .map((x) => ({
          stage:
            typeof x.stage === "number"
              ? Math.min(4, Math.max(1, Math.round(x.stage)))
              : 1,
          label: s(x.label, 12) ?? "",
          address: s(x.address, 12) ?? "",
          tone_note: s(x.tone_note, 60) ?? "",
        }))
        .filter((x) => x.label || x.address || x.tone_note)
        .slice(0, 4)
    : undefined;

  const sample_dialogues = Array.isArray(o.sample_dialogues)
    ? o.sample_dialogues
        .map(rec)
        .map((x) => ({ scene: s(x.scene, 20) ?? "", text: s(x.text, 120) ?? "" }))
        .filter((x) => x.text)
        .slice(0, 4)
    : undefined;

  return {
    name: s(o.name, 40),
    self_intro: s(o.self_intro, 80),
    personality: list(o.personality, 6, 20),
    speech: hasSpeech ? speech : undefined,
    backstory: s(o.backstory, 300),
    mystery_hooks: list(o.mystery_hooks, 3, 60),
    description: s(o.description, 400),
    scenario: s(o.scenario, 200),
    first_mes: s(o.first_mes, 200),
    alternate_greetings: list(o.alternate_greetings, 2, 200),
    tags: list(o.tags, 4, 12),
    sample_dialogues: sample_dialogues?.length ? sample_dialogues : undefined,
    relationship_stages: relationship_stages?.length ? relationship_stages : undefined,
  };
}

/**
 * 按用户已填的任意字段补全一张会长卡。
 * 已填字段保留其核心设定（落库时还会被表单值覆盖，双保险），空字段由模型发挥。
 */
export async function forgeCardFromFields(
  model: LanguageModel,
  input: ForgeFieldsInput,
): Promise<ForgedCard> {
  const lines: string[] = [];
  const add = (label: string, value?: string) => {
    const t = value?.trim();
    if (t) lines.push(`【${label}】${t}`);
  };
  add("名字", input.name);
  add("描述", input.description);
  add("性格", input.personality);
  add("场景", input.scenario);
  add("开场白", input.firstMes);
  add("标签", input.tags);

  const prompt = [
    `用户已填写以下内容（请沿用其核心设定，保持内在一致）：\n${lines.join("\n")}`,
    "请补全这张会长卡：已列出的字段沿用其设定，未列出的字段由你合理发挥。",
    `只输出一个 JSON 对象，结构如下（字段名与层级必须一致）：\n${JSON_SHAPE}`,
  ].join("\n\n");

  // 思考型模型偶尔把 token 花在 reasoning 上导致正文为空 / JSON 截断 → 重试一次；
  // 但超时（本地模型很慢）不重试，避免把等待时间翻倍。
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({
        model,
        system: FORGE_SYSTEM,
        prompt,
        maxOutputTokens: 1200,
        abortSignal: AbortSignal.timeout(240_000),
      });
      return normalizeForged(extractJson(text));
    } catch (e) {
      lastError = e;
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || name === "TimeoutError") break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型没有返回可解析的会长卡");
}
