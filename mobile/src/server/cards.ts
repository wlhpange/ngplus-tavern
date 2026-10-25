import type { PersonaJson, RelationshipStage } from "./llm/prompts";

/**
 * 关系阶段默认四档（P3：新增「恋人」）。卡面可自定义命名/称呼/语气，
 * 缺档或漏档时按 stage 与默认合并，保证任意阶段提示词层都有内容。
 */
export function defaultRelationshipStages(): RelationshipStage[] {
  return [
    { stage: 1, label: "初识", address: "新面孔", tone_note: "客气中带着打量" },
    { stage: 2, label: "熟络", address: "老熟人", tone_note: "随意，会主动起话头" },
    { stage: 3, label: "挚友", address: "自家人", tone_note: "护短，说话不再过脑子" },
    { stage: 4, label: "恋人", address: "亲爱的", tone_note: "亲昵、直白，会流露依恋" },
  ];
}

/**
 * 关系阶段合并：给到的档位用卡面内容，缺的档位用默认补齐，
 * 收敛为 stage 1..4 的完整结构。
 */
export function normalizeRelationshipStages(
  provided?: PersonaJson["relationship_stages"],
): NonNullable<PersonaJson["relationship_stages"]> {
  const defaults = defaultRelationshipStages();
  if (!provided?.length) return defaults;
  return defaults.map((d) => {
    const p = provided.find((s) => s != null && s.stage === d.stage);
    if (!p) return d;
    return {
      stage: d.stage,
      label: (p.label ?? "").trim() || d.label,
      address: (p.address ?? "").trim() || d.address,
      tone_note: (p.tone_note ?? "").trim() || d.tone_note,
    };
  });
}

/**
 * P1 会长卡 v1 工具层。
 *
 * 卡片是数据：本模块只做「老卡 → 卡片 v1」的归一化与开场白推导，不含任何具体
 * 人设文案。对齐 Character Card V2/V3 的子集：description / scenario / first_mes /
 * alternate_greetings / mes_example / system_prompt / post_history_instructions /
 * tags 等字段分字段保存；本项目自有的 backstory / mystery_hooks /
 * sample_dialogues / relationship_stages / speech 作为扩展字段保留。
 */

/** 由 sample_dialogues 渲染 CC 形态的 mes_example（导出/兼容用） */
function renderMesExample(
  samples: PersonaJson["sample_dialogues"],
): string {
  if (!samples?.length) return "";
  return samples
    .map((s) => `{{char}}（${s.scene}）：${s.text}`)
    .join("\n");
}

/**
 * 老卡 → 卡片 v1 归一化（幂等，可反复调用）。
 * - description 缺失时用 backstory 兜底；
 * - first_mes 缺失时用 self_intro 兜底；
 * - mes_example 缺失时由 sample_dialogues 渲染；
 * - 数组字段保证是数组（防脏数据）。
 * 不销毁任何未知字段（CC 规范的 MUST NOT destroy 要求）。
 */
export function normalizeCard(raw: unknown): PersonaJson {
  const c = (raw && typeof raw === "object" ? raw : {}) as PersonaJson;
  const description = c.description?.trim() || c.backstory?.trim() || "";
  const firstMes = c.first_mes?.trim() || c.self_intro?.trim() || "";
  return {
    ...c,
    description: description || undefined,
    first_mes: firstMes || undefined,
    alternate_greetings: Array.isArray(c.alternate_greetings)
      ? c.alternate_greetings.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : [],
    mes_example: c.mes_example?.trim() || renderMesExample(c.sample_dialogues) || undefined,
    tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
    extensions: c.extensions ?? {},
  };
}

/** 解析 masters.persona_json（统一走归一化，兼容老卡；关系阶段补齐四档） */
export function parseCard(personaJson: string): PersonaJson {
  let raw: unknown = {};
  try {
    raw = JSON.parse(personaJson);
  } catch {
    raw = {};
  }
  const card = normalizeCard(raw);
  card.relationship_stages = normalizeRelationshipStages(card.relationship_stages);
  return card;
}

/**
 * 开场白推导：index=0 取 first_mes，之后依次取 alternate_greetings；
 * 都没有时给一句中性兜底（用会长名字，不含具体人设措辞）。
 */
export function deriveGreeting(
  card: PersonaJson,
  masterName: string,
  index = 0,
): string {
  const greetings = [
    card.first_mes?.trim() ?? "",
    ...(card.alternate_greetings ?? []).map((g) => g.trim()),
  ].filter((g) => g.length > 0);
  if (greetings.length > 0) {
    return greetings[Math.min(Math.max(0, index), greetings.length - 1)];
  }
  return `「来了。」${masterName}抬头看了你一眼。`;
}

/** 可选开场白条数（含首条）——供 UI 展示「换开场白」 */
export function greetingCount(card: PersonaJson): number {
  return (
    (card.first_mes?.trim() ? 1 : 0) +
    (card.alternate_greetings?.filter((g) => g.trim().length > 0).length ?? 0)
  );
}

/** 全部开场白（首条 + 备选），过滤空串 */
export function allGreetings(card: PersonaJson): string[] {
  return [
    card.first_mes?.trim() ?? "",
    ...(card.alternate_greetings ?? []).map((g) => g.trim()),
  ].filter((g) => g.length > 0);
}
