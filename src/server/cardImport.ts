import type { PersonaJson } from "./llm/prompts";

/**
 * P5 生态导入：解析 Character Card V1/V2/V3（JSON 或 PNG 内嵌 tEXt chunk），
 * 映射为本项目的会长卡（PersonaJson）。CHARX（zip）暂不支持。
 *
 * 规范事实（已核对 SillyTavern 源码 src/character-card-parser.js）：
 * - PNG 里卡的 JSON 存在 tEXt chunk，`chara`(V2) / `ccv3`(V3) 两个 keyword，
 *   值为 utf8 JSON 的 base64；读取时 ccv3 优先。
 */

export type CardSpec = "v1" | "v2" | "v3";

export interface ImportedCard {
  name: string;
  persona: PersonaJson;
  /** 卡片内嵌的 character_book（原样，交给 convertCharacterBook 转换） */
  characterBook: unknown | null;
  spec: CardSpec;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** 从 PNG 字节里抽出全部 tEXt chunk（keyword, text） */
export function extractPngTextChunks(
  bytes: Buffer,
): { keyword: string; text: string }[] {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("不是 PNG 文件");
  }
  const chunks: { keyword: string; text: string }[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("latin1", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        chunks.push({
          keyword: data.toString("latin1", 0, nul),
          text: data.toString("latin1", nul + 1),
        });
      }
    }
    off = dataEnd + 4; // 跳过 CRC
    if (type === "IEND") break;
  }
  return chunks;
}

/**
 * 解析卡文件字节为原始卡对象：PNG 走 tEXt chunk（ccv3 优先于 chara），
 * 其余按 UTF-8 JSON 文本解析。
 */
export function parseCardBytes(bytes: Buffer, filename = ""): unknown {
  const isPng =
    bytes.length > 8 &&
    PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  let jsonText: string;
  if (isPng || filename.toLowerCase().endsWith(".png")) {
    const chunks = extractPngTextChunks(bytes);
    const pick = (kw: string) =>
      chunks.find((c) => c.keyword.toLowerCase() === kw)?.text;
    const encoded = pick("ccv3") ?? pick("chara");
    if (!encoded) throw new Error("PNG 里没有角色卡数据（缺 ccv3/chara chunk）");
    jsonText = Buffer.from(encoded, "base64").toString("utf8");
  } else {
    jsonText = bytes.toString("utf8");
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error("角色卡不是合法 JSON");
  }
}

function toTextArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    return v
      .split(/[\n、,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * 原始卡对象 → 本项目会长卡。
 * V2/V3 的字段在 `data` 里；V1 是平铺的。未识别的字段原样保留。
 */
export function toImportedCard(raw: unknown): ImportedCard {
  if (!raw || typeof raw !== "object") throw new Error("角色卡内容为空");
  const obj = raw as Record<string, unknown>;
  const spec: CardSpec =
    obj.spec === "chara_card_v3"
      ? "v3"
      : obj.spec === "chara_card_v2"
        ? "v2"
        : "v1";
  const data =
    (obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : obj) ?? {};

  const name = String(data.name ?? "").trim();
  if (!name) throw new Error("角色卡缺少名字");

  const persona: PersonaJson = {
    description: typeof data.description === "string" ? data.description : undefined,
    personality: toTextArray(data.personality),
    scenario: typeof data.scenario === "string" ? data.scenario : undefined,
    first_mes: typeof data.first_mes === "string" ? data.first_mes : undefined,
    alternate_greetings: toTextArray(data.alternate_greetings),
    mes_example: typeof data.mes_example === "string" ? data.mes_example : undefined,
    system_prompt: typeof data.system_prompt === "string" ? data.system_prompt : undefined,
    post_history_instructions:
      typeof data.post_history_instructions === "string"
        ? data.post_history_instructions
        : undefined,
    creator_notes: typeof data.creator_notes === "string" ? data.creator_notes : undefined,
    tags: toTextArray(data.tags),
    creator: typeof data.creator === "string" ? data.creator : undefined,
    character_version:
      typeof data.character_version === "string" ? data.character_version : undefined,
    extensions:
      data.extensions && typeof data.extensions === "object"
        ? (data.extensions as Record<string, unknown>)
        : {},
    // 本项目自有字段在导入的卡里不存在，留空由上层推导
    self_intro: undefined,
    backstory: undefined,
    speech: undefined,
    mystery_hooks: undefined,
    sample_dialogues: undefined,
  };

  return {
    name,
    persona,
    characterBook: data.character_book ?? null,
    spec,
  };
}
