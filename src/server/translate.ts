import { generateText, type LanguageModel } from "ai";
import type { ImportedCard } from "./cardImport";
import type { PersonaJson } from "./llm/prompts";

/**
 * P11 角色卡翻译：导入外语卡时，把卡里的提示词忠实翻译成简体中文。
 *
 * 铁律（用户明确要求）：
 * - 原模原样：不增删、不改写、不润色、不总结、不回避；
 * - 人名/地名/专有名词保持原文；
 * - 保留全部格式与标记（换行、*动作*、引号、括号、{{user}}/{{char}} 宏、<START>、Markdown）；
 * - 包含R18 内容时如实译出，不做审查与淡化。
 */

const SYSTEM = [
  "你是专业文学翻译，负责把角色卡（角色扮演设定）的文本忠实翻译成简体中文。",
  "严格遵守以下铁律：",
  "1. 忠实原文：逐句直译，不增删、不改写、不润色、不总结、不省略。",
  "2. 人名、地名、专有名词保持原文，不翻译、不音译、不改写。",
  "3. 保留全部格式与标记：换行、星号 *动作*、引号、括号、{{user}}/{{char}} 这类宏、<START>、Markdown 记号，原样保留。",
  "4. 不回避、不审查、不淡化任何内容。原文若含R18 内容、暴力、粗俗用语，一律如实译出，不做任何删改或委婉化。",
  "5. 只输出译文本身，不要任何解释、前言、后记或额外说明。",
].join("\n");

/** 是否以拉丁字母/非中文为主（粗略判定"需要翻译"） */
export function needsTranslation(text: string | undefined | null): boolean {
  if (!text) return false;
  const chars = [...text].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return false;
  const cjk = chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
  const latin = chars.filter((c) => /[A-Za-z]/.test(c)).length;
  if (latin === 0) return false;
  // 拉丁字母占比高、且中文占比低 → 视为外语为主
  return latin / chars.length > 0.3 && cjk < chars.length * 0.5;
}

/** 单段忠实翻译（长文本用，逐字段调用，避免结构化输出截断） */
export async function translateText(model: LanguageModel, text: string): Promise<string> {
  if (!text || !needsTranslation(text)) return text;
  // 思考型模型偶尔把 token 全花在 reasoning 上导致正文为空 → 重试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { text: out } = await generateText({
        model,
        system: SYSTEM,
        prompt: text,
        maxOutputTokens: 8000,
        abortSignal: AbortSignal.timeout(60_000),
      });
      const trimmed = out.trim();
      if (trimmed.length > 0) return trimmed;
    } catch {
      // 继续重试
    }
  }
  return text; // 多次失败保留原文，不阻断导入
}

/** 并发映射（限制并发数，避免打爆网关） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 批量分隔标记（出现在卡文本里的概率极低） */
const BATCH_SEP = "<<<===>>>";

/**
 * 批量忠实翻译（条目内容/关键词等用；用分隔标记保证条数与顺序）。
 * 用 generateText + 分隔符，而不是结构化输出——跨供应商更稳，也更便于测试。
 */
export async function translateBatch(
  model: LanguageModel,
  items: string[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const joined = items.join(`\n${BATCH_SEP}\n`);
  const prompt = [
    `下面共有 ${items.length} 段文本，用一行 ${BATCH_SEP} 分隔。`,
    `请逐段忠实翻译成简体中文，并原样保留分隔符 ${BATCH_SEP}（段数与顺序不变）。`,
    `每段内部原有的换行要保留。只输出译文，不要编号、不要解释。`,
    "",
    joined,
  ].join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { text: out } = await generateText({
        model,
        system: SYSTEM,
        prompt,
        maxOutputTokens: 8000,
        abortSignal: AbortSignal.timeout(90_000),
      });
      const parts = out.split(BATCH_SEP).map((s) => s.trim());
      if (parts.length === items.length) {
        return parts.map((t, i) => (t.length > 0 ? t : items[i]));
      }
    } catch {
      // 重试
    }
  }
  return items; // 结构不符/多次失败 → 保留原文
}

const BATCH = 8;

/** 翻译被取消时抛出 */
export class TranslateCancelledError extends Error {
  constructor() {
    super("已取消翻译");
    this.name = "TranslateCancelledError";
  }
}

export interface TranslateOptions {
  /** 每完成一个翻译单元回调一次（done/total） */
  onProgress?: (done: number, total: number) => void;
  /** 返回 true 时尽快中止 */
  shouldStop?: () => boolean;
}

/** 翻译单元总数（进度条用；与 bump 次数一致） */
export function countTranslationUnits(card: ImportedCard): number {
  const p = card.persona;
  let total = 0;
  for (const v of [
    p.description,
    p.backstory,
    p.scenario,
    p.first_mes,
    p.mes_example,
    p.system_prompt,
    p.post_history_instructions,
    p.creator_notes,
  ]) {
    if (needsTranslation(v)) total++;
  }
  if ((p.personality ?? []).some(needsTranslation)) total++;
  if ((p.alternate_greetings ?? []).some(needsTranslation)) total++;
  if ((p.sample_dialogues ?? []).some((s) => needsTranslation(s.text))) total++;

  const src = card.characterBook as CcBook | null;
  if (src && Array.isArray(src.entries)) {
    const foreignContent = src.entries.filter((e) =>
      needsTranslation(typeof e.content === "string" ? e.content : ""),
    ).length;
    total += Math.ceil(foreignContent / BATCH);
    const hasForeignKey = src.entries.some((e) =>
      (["keys", "secondary_keys"] as const).some(
        (f) => Array.isArray(e[f]) && (e[f] as unknown[]).some((x) => typeof x === "string" && needsTranslation(x)),
      ),
    );
    if (hasForeignKey) total++;
  }
  return total;
}

/** 逐字段翻译会长卡（persona）——所有字段并发，显著提速 */
async function translatePersona(
  model: LanguageModel,
  p: PersonaJson,
  bump: () => void,
  shouldStop: () => boolean,
): Promise<PersonaJson> {
  const out: PersonaJson = structuredClone(p);
  const one = async (v?: string) => (v && needsTranslation(v) ? await translateText(model, v) : v);

  const singleKeys = [
    "description",
    "backstory",
    "scenario",
    "first_mes",
    "mes_example",
    "system_prompt",
    "post_history_instructions",
    "creator_notes",
  ] as const;
  await Promise.all(
    singleKeys.map(async (k) => {
      if (!needsTranslation(out[k])) return;
      if (shouldStop()) throw new TranslateCancelledError();
      out[k] = await one(out[k]);
      bump();
    }),
  );

  const personality =
    (out.personality ?? []).some(needsTranslation) && out.personality?.length
      ? await translateBatch(model, out.personality)
      : null;
  if (personality) {
    out.personality = personality;
    bump();
  }
  const greetings =
    (out.alternate_greetings ?? []).some(needsTranslation) && out.alternate_greetings?.length
      ? await translateBatch(model, out.alternate_greetings)
      : null;
  if (greetings) {
    out.alternate_greetings = greetings;
    bump();
  }
  const sampleTexts =
    (out.sample_dialogues ?? []).some((s) => needsTranslation(s.text)) && out.sample_dialogues?.length
      ? await translateBatch(
          model,
          out.sample_dialogues.map((s) => s.text),
        )
      : null;
  if (sampleTexts && out.sample_dialogues) {
    out.sample_dialogues = out.sample_dialogues.map((s, i) => ({ ...s, text: sampleTexts[i] }));
    bump();
  }
  return out;
}

interface CcBook {
  entries?: {
    keys?: unknown;
    secondary_keys?: unknown;
    content?: unknown;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}

/** 翻译卡内世界书：内容 + 关键词（关键词保留原文并追加译文，兼顾中英触发） */
async function translateCharacterBook(
  model: LanguageModel,
  book: unknown,
  bump: () => void,
  shouldStop: () => boolean,
): Promise<unknown> {
  const src = book as CcBook | null;
  if (!src || !Array.isArray(src.entries)) return book;
  const cloned = structuredClone(src);

  const pending = cloned
    .entries!.map((e, i) => ({ i, c: typeof e.content === "string" ? e.content : "" }))
    .filter((x) => needsTranslation(x.c));

  const chunks: { i: number; c: string }[][] = [];
  for (let s = 0; s < pending.length; s += BATCH) chunks.push(pending.slice(s, s + BATCH));

  const keyStrings: string[] = [];
  const keyRefs: { entry: number; field: "keys" | "secondary_keys"; idx: number }[] = [];
  cloned.entries!.forEach((e, ei) => {
    for (const field of ["keys", "secondary_keys"] as const) {
      const arr = Array.isArray(e[field]) ? (e[field] as unknown[]) : [];
      arr.forEach((k, ki) => {
        if (typeof k === "string" && needsTranslation(k)) {
          keyStrings.push(k);
          keyRefs.push({ entry: ei, field, idx: ki });
        }
      });
    }
  });

  const chunkResults = await mapLimit(chunks, 4, async (chunk) => {
    if (shouldStop()) throw new TranslateCancelledError();
    const r = await translateBatch(model, chunk.map((x) => x.c));
    bump();
    return r;
  });
  chunks.forEach((chunk, ci) => {
    chunk.forEach((x, j) => {
      cloned.entries![x.i].content = chunkResults[ci][j];
    });
  });

  if (keyStrings.length) {
    if (shouldStop()) throw new TranslateCancelledError();
    const translatedKeys = await translateBatch(model, keyStrings);
    bump();
    keyRefs.forEach((ref, i) => {
      const entry = cloned.entries![ref.entry];
      const arr = Array.isArray(entry[ref.field]) ? (entry[ref.field] as string[]) : [];
      const translated = translatedKeys[i];
      if (translated && translated !== arr[ref.idx]) {
        arr.push(translated);
        entry[ref.field] = Array.from(new Set(arr));
      }
    });
  }

  return cloned;
}

export interface ImportedCardTranslation {
  card: ImportedCard;
  translatedFields: number;
  translatedEntries: number;
}

/**
 * 翻译整张导入卡（persona + 世界书）。任何一段失败都保留原文，不阻断导入。
 * 支持进度回调与取消（shouldStop 抛 TranslateCancelledError）。
 */
export async function translateImportedCard(
  model: LanguageModel,
  card: ImportedCard,
  opts: TranslateOptions = {},
): Promise<ImportedCardTranslation> {
  const total = countTranslationUnits(card);
  let done = 0;
  const bump = () => opts.onProgress?.(++done, total);
  const shouldStop = opts.shouldStop ?? (() => false);
  opts.onProgress?.(0, total);

  const persona = await translatePersona(model, card.persona, bump, shouldStop);
  const characterBook = card.characterBook
    ? await translateCharacterBook(model, card.characterBook, bump, shouldStop)
    : card.characterBook;

  return {
    card: { ...card, persona, characterBook },
    translatedFields: countForeignPersonaFields(card.persona),
    translatedEntries: countForeignBookEntries(card.characterBook),
  };
}

/** persona 里需要翻译的字段数（预览用） */
export function countForeignPersonaFields(p: PersonaJson): number {
  let n = 0;
  for (const v of [
    p.description,
    p.backstory,
    p.scenario,
    p.first_mes,
    p.mes_example,
    p.system_prompt,
    p.post_history_instructions,
    p.creator_notes,
  ]) {
    if (needsTranslation(v)) n++;
  }
  n += (p.personality ?? []).filter(needsTranslation).length;
  n += (p.alternate_greetings ?? []).filter(needsTranslation).length;
  n += (p.sample_dialogues ?? []).filter((s) => needsTranslation(s.text)).length;
  return n;
}

/** 世界书里需要翻译的条目数（预览用） */
export function countForeignBookEntries(book: unknown): number {
  const src = book as CcBook | null;
  if (!src || !Array.isArray(src.entries)) return 0;
  return src.entries.filter((e) => needsTranslation(typeof e.content === "string" ? e.content : "")).length;
}

/** 预览：卡里是否有需要翻译的外语提示词 */
export function translationPreview(card: ImportedCard): {
  fields: number;
  entries: number;
  needed: boolean;
} {
  const fields = countForeignPersonaFields(card.persona);
  const entries = countForeignBookEntries(card.characterBook);
  return { fields, entries, needed: fields + entries > 0 };
}
