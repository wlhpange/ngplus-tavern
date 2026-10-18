import fs from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { masters } from "./db/schema";
import { setMasterSprite } from "./masters";
import { modelFromDb } from "./modelConfig";
import { SLOT_ORDER, type PetCatalog, type PetDescriptor, type PetPalettes } from "@/lib/petCatalog";

/**
 * 会长 → 像素小人形象参数的映射。
 *
 * 不用图像生成：只把「角色卡文字」翻译成「部件 + 颜色」参数（从固定枚举里选）。
 * 优先用 LLM（跨供应商稳的 generateText + JSON 解析），失败 / 无 Key 时退回关键词规则。
 * 结果再由 catalog / palettes 校验收敛，保证一定可渲染。
 */

const LPC_DIR = path.join(process.cwd(), "public", "sprites", "lpc");

let vocabCache: { catalog: PetCatalog; palettes: PetPalettes } | null = null;
function loadVocab(): { catalog: PetCatalog; palettes: PetPalettes } {
  if (!vocabCache) {
    vocabCache = {
      catalog: JSON.parse(fs.readFileSync(path.join(LPC_DIR, "catalog.json"), "utf8")) as PetCatalog,
      palettes: JSON.parse(fs.readFileSync(path.join(LPC_DIR, "palettes.json"), "utf8")) as PetPalettes,
    };
  }
  return vocabCache;
}

export function defaultSprite(): PetDescriptor {
  return {
    bodyType: "female",
    items: {
      body: "body",
      head: "heads_human_female",
      face: "face_neutral",
      hair: "hair_ponytail",
      top: "torso_clothes_tshirt",
      bottom: "legs_pants",
      shoes: "feet_boots_basic",
    },
    colors: { body: "light", hair: "blonde", cloth: "purple", eye: "green" },
  };
}

/** 收敛：剔除不可用部件 / 非法颜色；body 必选 */
export function sanitizeSprite(raw: Partial<PetDescriptor> | null | undefined): PetDescriptor {
  const { catalog, palettes } = loadVocab();
  const d = defaultSprite();
  const bodyType = raw?.bodyType && catalog.bodyTypes.includes(raw.bodyType) ? raw.bodyType : d.bodyType;
  const items: Record<string, string | undefined> = {};
  for (const slot of SLOT_ORDER) {
    const id = raw?.items?.[slot];
    const it = id ? catalog.items[id] : undefined;
    if (it && it.slot === slot && it.bodyTypes.includes(bodyType)) items[slot] = id;
  }
  if (!items.body) items.body = "body";
  if (!items.head) items.head = bodyType === "male" ? "heads_human_male" : "heads_human_female";
  if (!items.face) items.face = "face_neutral";
  const colors: Record<string, string | undefined> = {};
  for (const mat of Object.keys(palettes)) {
    const name = raw?.colors?.[mat];
    if (name && palettes[mat].colors[name]) colors[mat] = name;
  }
  const itemVariants: Record<string, string | undefined> = {};
  for (const slot of SLOT_ORDER) {
    const it = items[slot] ? catalog.items[items[slot]!] : null;
    if (it?.layout === "variant" && it.variants?.length) {
      const cur = raw?.itemVariants?.[slot];
      itemVariants[slot] = cur && it.variants.includes(cur) ? cur : it.variants[0];
    }
  }
  return { bodyType, items, colors, itemVariants };
}

/** 关键词兜底：从卡文字里抓体型 / 发色 / 衣色 / 瞳色 / 部件 */
export function keywordSprite(text: string): PetDescriptor {
  const { catalog, palettes } = loadVocab();
  const t = text.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w.toLowerCase()));
  const pick = (mat: string, pairs: [string[], string][], fallback: string): string => {
    for (const [words, color] of pairs) {
      if (has(...words) && palettes[mat]?.colors[color]) return color;
    }
    return fallback;
  };
  const pickItem = (slot: string, pairs: [string[], string][], fallback: string): string => {
    for (const [words, id] of pairs) {
      const it = catalog.items[id];
      if (has(...words) && it && it.slot === slot) return id;
    }
    return fallback;
  };

  const bodyType = has("男", "男性", "male", "先生", "少年", "大叔") ? "male" : "female";
  const d = defaultSprite();
  d.bodyType = bodyType;
  d.items.head = bodyType === "male" ? "heads_human_male" : "heads_human_female";
  d.items.face = pickItem("face", [
    [["笑", "开心", "高兴", "愉快"], "face_happy"],
    [["难过", "悲伤", "哭", "哀"], "face_sad"],
    [["生气", "愤怒", "恼"], "face_angry"],
    [["惊讶", "震惊", "吃惊"], "face_shock"],
    [["害羞", "脸红", "羞涩"], "face_blush"],
  ], "face_neutral");
  d.items.hair = pickItem("hair", [
    [["马尾", "马尾辫"], "hair_ponytail"],
    [["辫子", "麻花辫", "辫"], "hair_braid"],
    [["波波头", "短发", "齐肩"], "hair_bob"],
    [["长直", "长发", "长卷", "披肩"], "hair_long_tied"],
  ], "hair_ponytail");
  d.items.top = pickItem("top", [
    [["盔甲", "铠甲", "皮甲", "护甲"], "torso_armour_leather"],
    [["长袖", "风衣", "大衣"], "torso_clothes_longsleeve2"],
    [["背心", "无袖", "吊带"], "torso_clothes_sleeveless2"],
    [["衬衫", "衬衣"], "torso_clothes_shortsleeve"],
  ], "torso_clothes_tshirt");
  d.items.bottom = pickItem("bottom", [
    [["短裤"], "legs_shorts"],
    [["裙", "长裙"], "legs_skirts_plain"],
    [["长裤", "裤子", "西裤"], "legs_pants2"],
  ], "legs_pants");
  d.items.shoes = pickItem("shoes", [
    [["靴", "军靴"], "feet_boots_basic"],
    [["凉鞋", "拖鞋", "草鞋"], "feet_sandals"],
  ], "feet_shoes_basic");
  d.colors.body = pick("body", [
    [["苍白", "白皙", "雪白"], "porcelain"],
    [["小麦", "晒黑", "古铜", "tan"], "tan"],
    [["深色皮肤", "黑皮"], "brown"],
  ], "light");
  d.colors.hair = pick("hair", [
    [["银", "白", "银白", "雪"], "white"],
    [["金", "金黄", "blonde"], "blonde"],
    [["黑"], "black"],
    [["红", "火"], "red"],
    [["棕", "褐", "栗"], "light_brown"],
    [["粉"], "strawberry"],
    [["紫"], "purple"],
  ], "blonde");
  d.colors.cloth = pick("cloth", [
    [["红"], "red"],
    [["蓝"], "blue"],
    [["紫"], "purple"],
    [["绿"], "green"],
    [["黑"], "black"],
    [["白"], "white"],
    [["粉"], "pink"],
    [["黄"], "yellow"],
    [["棕", "褐"], "brown"],
    [["灰"], "gray"],
    [["橙"], "orange"],
  ], "purple");
  d.colors.eye = pick("eye", [
    [["金瞳", "金眼"], "yellow"],
    [["红瞳", "红眼", "血瞳"], "red"],
    [["紫瞳", "紫眼"], "purple"],
    [["绿瞳", "绿眼"], "green"],
    [["棕瞳", "褐瞳"], "brown"],
    [["灰瞳"], "gray"],
  ], "green");
  return sanitizeSprite(d);
}

function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

const SYSTEM = [
  "你是「二周目协会」的形象设计师。用户给出一个会长的角色设定文字。",
  "你的任务：从给定的固定部件/颜色清单里，为 ta 挑一套最贴合描述的像素小人形象。",
  "只输出一个 JSON 对象，不要任何解释或代码围栏。",
  "字段：bodyType（female/male）、items（每个槽位选一个 id；face/hair/top/bottom/shoes 可留 null）、colors（每个材质选一个颜色名）。",
  "只能从下面清单里取值，不要编造；拿不准就用默认值。",
].join("\n");

async function llmSprite(model: LanguageModel, text: string): Promise<PetDescriptor> {
  const { catalog, palettes } = loadVocab();
  const slotLines = catalog.slots.map((s) => {
    const ids = Object.entries(catalog.items)
      .filter(([, it]) => it.slot === s.key)
      .map(([id, it]) => `${id}(${it.label})`)
      .join(", ");
    return `${s.key} ${s.label}: ${ids || "（无）"}`;
  });
  const colorLines = Object.keys(palettes).map(
    (m) => `${m}(${palettes[m].label ?? m}): ${Object.keys(palettes[m].colors).join(", ")}`,
  );
  const shape = `{"bodyType":"female","items":{"body":"body","head":"heads_human_female","face":"face_neutral","hair":"hair_ponytail","top":"torso_clothes_tshirt","bottom":"legs_pants","shoes":"feet_boots_basic"},"colors":{"body":"light","hair":"blonde","cloth":"purple","eye":"green"}}`;

  const prompt = [
    `【角色设定】\n${text.slice(0, 2000)}`,
    `【可选的 bodyType】female（女）/ male（男）`,
    `【槽位与可选部件】\n${slotLines.join("\n")}`,
    `【可选颜色】\n${colorLines.join("\n")}`,
    `只输出一个 JSON 对象，结构示例：\n${shape}`,
  ].join("\n\n");

  const { text: out } = await generateText({
    model,
    system: SYSTEM,
    prompt,
    maxOutputTokens: 700,
    abortSignal: AbortSignal.timeout(120_000),
  });
  return sanitizeSprite(extractJson(out) as Partial<PetDescriptor>);
}

/** 由卡文字得到形象参数：LLM 优先，失败退关键词 */
export async function mapSpriteFromText(
  model: LanguageModel | null,
  text: string,
): Promise<PetDescriptor> {
  if (model) {
    try {
      return await llmSprite(model, text);
    } catch {
      /* 落回关键词 */
    }
  }
  return keywordSprite(text);
}

/** 把会长卡的可见文字拼成映射用文本 */
function masterSpriteText(name: string, personaJson: string): string {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(personaJson) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("、") : "");
  return [
    `名字：${name}`,
    `简介：${str(p.self_intro)}`,
    `描述：${str(p.description)}`,
    `性格：${arr(p.personality)}`,
    `场景：${str(p.scenario)}`,
    `来历：${str(p.backstory)}`,
    `标签：${arr(p.tags)}`,
  ]
    .filter((s) => s.split("：")[1])
    .join("\n");
}

/** 导入/新增后自动生成形象并落库；返回 descriptor */
export async function autoMapSpriteForMaster(
  db: Db,
  userId: string,
  masterId: string,
): Promise<PetDescriptor> {
  const row = db.select().from(masters).where(eq(masters.id, masterId)).get();
  if (!row) throw new Error("会长不存在");
  const text = masterSpriteText(row.name, row.personaJson);
  let model: LanguageModel | null = null;
  try {
    model = modelFromDb(db);
  } catch {
    model = null;
  }
  const sprite = await mapSpriteFromText(model, text);
  setMasterSprite(db, userId, masterId, JSON.stringify(sprite));
  return sprite;
}
