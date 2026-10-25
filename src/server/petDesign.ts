import { SLOT_ORDER, type PetCatalog, type PetDescriptor, type PetPalettes } from "../weblib/petCatalog";
import catalogJson from "./pet_catalog.json";
import palettesJson from "./pet_palettes.json";

/**
 * 会长卡文字 → 像素小人参数（纯逻辑，不碰 DB / LLM，便于单测）。
 *
 * 之前这里只认中文关键词，而且读卡时只取了 description / personality 等少数几栏：
 * 英文卡、只在外貌段或开场白里写了长相的卡，最后都会落回 defaultSprite()，
 * 于是「每位会长看起来都一样」。现在按「属性名词 + 邻近颜色」的窗口取色，
 * 英文 / 中文都能命中，并把更多卡字段纳入文本。
 */

export type SpriteSource = "llm" | "rules";

let vocab: { catalog: PetCatalog; palettes: PetPalettes } | null = null;
export function loadVocab(): { catalog: PetCatalog; palettes: PetPalettes } {
  if (!vocab) {
    vocab = {
      catalog: catalogJson as unknown as PetCatalog,
      palettes: palettesJson as unknown as PetPalettes,
    };
  }
  return vocab;
}

export function defaultSprite(): PetDescriptor {
  return {
    bodyType: "female",
    items: {
      body: "body",
      head: "heads_human_female",
      face: "face_neutral",
      hair: "hair_ponytail",
      top: "torso_clothes_longsleeve2",
      bottom: "legs_pants2",
      shoes: "feet_shoes_basic",
    },
    colors: { body: "light", hair: "blonde", cloth: "purple", eye: "green" },
  };
}

/** 宽松解析部件 id：LLM 常把 `torso_clothes_longsleeve2` 写成 `longsleeve2` 或标签名 */
function resolveItemId(slot: string, rawId: string | undefined, bodyType: string): string | undefined {
  if (!rawId) return undefined;
  const { catalog } = loadVocab();
  const want = rawId.trim().toLowerCase();
  const pool = Object.entries(catalog.items).filter(
    ([, it]) => it.slot === slot && it.bodyTypes.includes(bodyType),
  );
  const hit =
    pool.find(([id]) => id.toLowerCase() === want) ??
    pool
      .filter(([id]) => id.toLowerCase().endsWith(`_${want}`))
      .sort((a, b) => a[0].length - b[0].length)[0] ??
    pool.find(([, it]) => it.label.toLowerCase() === want);
  return hit?.[0];
}

/** 宽松解析颜色名：silver → white、grey → gray 之类 */
function resolveColorName(mat: string, rawName: string | undefined): string | undefined {
  const palette = loadVocab().palettes[mat];
  if (!rawName || !palette) return undefined;
  const want = rawName.trim().toLowerCase();
  if (palette.colors[rawName]) return rawName;
  if (palette.colors[want]) return want;
  const alias = COLORS[mat]?.[want];
  return alias && palette.colors[alias] ? alias : undefined;
}

/** 收敛：剔除不可用部件 / 非法颜色；body 必选 */
export function sanitizeSprite(raw: Partial<PetDescriptor> | null | undefined): PetDescriptor {
  const { catalog } = loadVocab();
  const d = defaultSprite();
  const rawBody = String(raw?.bodyType ?? "").toLowerCase();
  const bodyType =
    ["male", "m", "man", "男"].includes(rawBody) && catalog.bodyTypes.includes("male")
      ? "male"
      : ["female", "f", "woman", "女"].includes(rawBody) && catalog.bodyTypes.includes("female")
        ? "female"
        : rawBody && catalog.bodyTypes.includes(rawBody)
          ? rawBody
          : d.bodyType;
  const items: Record<string, string | undefined> = {};
  for (const slot of SLOT_ORDER) {
    const id = resolveItemId(slot, raw?.items?.[slot], bodyType);
    if (id) items[slot] = id;
  }
  if (!items.body) items.body = "body";
  if (!items.head) items.head = bodyType === "male" ? "heads_human_male" : "heads_human_female";
  if (!items.face) items.face = "face_neutral";
  const colors: Record<string, string | undefined> = {};
  for (const mat of Object.keys(loadVocab().palettes)) {
    const name = resolveColorName(mat, raw?.colors?.[mat]);
    if (name) colors[mat] = name;
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

// ---------------------------------------------------------------- 文本 / 匹配工具

const isCJK = (s: string) => /[\u4e00-\u9fff]/.test(s);
const isAsciiWord = (s: string) => /^[a-z0-9][a-z0-9'’-]*$/i.test(s);

function countOf(text: string, word: string): number {
  if (!word) return 0;
  if (isAsciiWord(word)) {
    const m = text.match(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
    return m ? m.length : 0;
  }
  return text.split(word).length - 1;
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => countOf(text, w) > 0);
}

// ---------------------------------------------------------------- 颜色

/** 同一颜色在不同材质里的合法名字不一样：这里统一归一化到调色板里的键 */
const COLORS: Record<string, Record<string, string>> = {
  hair: {
    silver: "white", platinum: "platinum", white: "white", snow: "white", snowy: "white",
    ivory: "white", ash: "ash", grey: "gray", gray: "gray", gold: "gold", golden: "gold",
    blonde: "blonde", blond: "blonde", yellow: "sandy", sandy: "sandy",
    black: "black", raven: "raven", ebony: "black", dark: "dark_brown",
    red: "red", scarlet: "red", crimson: "red", auburn: "redhead", ginger: "ginger", carrot: "carrot",
    brown: "light_brown", chestnut: "chestnut", brunette: "dark_brown", chocolate: "dark_brown",
    pink: "strawberry", rose: "rose", purple: "purple", violet: "violet", lavender: "purple",
    blue: "blue", navy: "navy", green: "green", emerald: "green", orange: "orange",
    银白: "white", 银: "white", 白: "white", 雪白: "white", 金: "gold", 金黄: "gold",
    亚麻: "sandy", 黑: "black", 乌黑: "black", 红: "red", 赤: "red", 棕: "light_brown",
    褐: "light_brown", 栗: "chestnut", 粉: "strawberry", 紫: "purple", 蓝: "blue",
    绿: "green", 灰: "gray", 橙: "orange", 青: "blue",
  },
  cloth: {
    brown: "brown", leather: "leather", tan: "tan", beige: "tan", khaki: "tan", yellow: "yellow",
    golden: "yellow", gold: "yellow", orange: "orange", rose: "rose", pink: "rose",
    maroon: "maroon", red: "red", crimson: "red", scarlet: "red", wine: "maroon",
    lavender: "lavender", purple: "purple", violet: "violet", indigo: "purple",
    blue: "blue", navy: "navy", teal: "teal", cyan: "sky", sky: "sky", azure: "blue",
    forest: "forest", green: "green", emerald: "green", olive: "forest",
    white: "white", ivory: "white", snow: "white", silver: "sky", grey: "gray", gray: "slate",
    slate: "slate", black: "black", ebony: "black", charcoal: "charcoal", dark: "black",
    棕: "brown", 褐: "brown", 卡其: "tan", 米: "tan", 黄: "yellow", 金: "yellow",
    橙: "orange", 粉: "rose", 红: "red", 酒红: "maroon", 紫: "purple", 蓝: "blue",
    藏青: "navy", 青: "teal", 绿: "green", 白: "white", 银: "white", 灰: "gray",
    黑: "black", 墨: "charcoal",
  },
  eye: {
    blue: "blue", azure: "blue", sapphire: "blue", green: "green", emerald: "green",
    purple: "purple", violet: "purple", lavender: "purple", red: "red", crimson: "red",
    scarlet: "red", orange: "orange", amber: "orange", yellow: "yellow", gold: "yellow",
    golden: "yellow", brown: "brown", hazel: "brown", gray: "gray", grey: "gray",
    silver: "gray", black: "brown", dark: "brown",
    蓝: "blue", 绿: "green", 紫: "purple", 红: "red", 赤: "red", 橙: "orange",
    金: "yellow", 黄: "yellow", 褐: "brown", 棕: "brown", 灰: "gray", 银: "gray", 黑: "brown",
  },
  body: {
    pale: "light", fair: "light", porcelain: "light", ivory: "light", light: "light",
    white: "light", tan: "bronze", tanned: "bronze", bronze: "bronze", olive: "olive",
    brown: "brown", dark: "brown", black: "black", ebony: "black", amber: "amber",
    taupe: "taupe", lavender: "lavender",
    白皙: "light", 苍白: "light", 雪白: "light", 白: "light", 小麦: "bronze",
    晒黑: "bronze", 古铜: "bronze", 橄榄: "olive", 棕: "brown", 褐: "brown",
    深色: "brown", 黑: "black",
  },
};

const NOUNS: Record<string, string[]> = {
  hair: ["头发", "发絲", "发丝", "长发", "短发", "秀发", "发色", "青丝", "hair", "hairs", "locks", "mane", "haired"],
  eye: ["眼睛", "双眸", "双瞳", "眼眸", "眼瞳", "瞳孔", "眼", "瞳", "eyes", "eye", "irises", "iris"],
  cloth: [
    "风衣", "大衣", "外套", "长袍", "斗篷", "长裙", "短裙", "裙", "衬衫", "衬衣", "T恤", "西装",
    "皮甲", "铠甲", "盔甲", "长衣", "制服", "毛衣", "卫衣", "衣服", "衣裳", "衣",
    "coat", "cloak", "robe", "cape", "dress", "gown", "shirt", "blouse", "jacket",
    "armor", "armour", "uniform", "suit", "sweater", "hoodie", "skirt", "pants", "trousers",
  ],
  body: ["皮肤", "肤色", "肌肤", "肤色", "skin", "complexion"],
};

/** 英文里颜色通常写在名词前；中文同理，取名词前 6 个字 */
function colorFor(text: string, material: string): string | undefined {
  const aliases = COLORS[material];
  if (!aliases) return undefined;
  const nouns = NOUNS[material] ?? [];
  const cjkAliases = Object.entries(aliases)
    .filter(([k]) => isCJK(k))
    .sort((a, b) => b[0].length - a[0].length);

  for (const noun of nouns.filter(isCJK)) {
    let i = text.indexOf(noun);
    while (i >= 0) {
      const win = text.slice(Math.max(0, i - 6), i);
      for (const [tok, color] of cjkAliases) if (win.includes(tok)) return color;
      i = text.indexOf(noun, i + 1);
    }
  }

  const words = text.split(/[^a-z0-9'’-]+/).filter(Boolean);
  const nounSet = new Set(nouns.filter((n) => isAsciiWord(n)));
  const colorAt = (w: string | undefined) => (w ? aliases[w] : undefined);
  for (let i = 0; i < words.length; i++) {
    if (!nounSet.has(words[i])) continue;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      const hit = colorAt(words[j]);
      if (hit) return hit;
    }
    if (["is", "was", "are", "were", "of", "with"].includes(words[i + 1] ?? "")) {
      const hit = colorAt(words[i + 2]);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 部件

type Rule = [string[], string];

const HAIR_STYLES_EN: [RegExp, string][] = [
  [/\b(?:twin\s*tails|pigtails)\b/, "hair_pigtails"],
  [/\bhigh\s+ponytail\b/, "hair_high_ponytail"],
  [/\bponytail\b/, "hair_ponytail"],
  [/\b(?:braid|braids|plaits?)\b/, "hair_braid"],
  [/\b(?:bun|topknot)\b/, "hair_bangs_bun"],
  [/\bbob(?:\s+cut)?\b/, "hair_bob"],
  [/\bpixie\b/, "hair_pixie"],
  [/\bafro\b/, "hair_afro"],
  [/\b(?:dreadlocks?|dreads|cornrows)\b/, "hair_dreadlocks_long"],
  [/\bmohawk\b/, "hair_longhawk"],
  [/\b(?:buzz\s*cut|shaved\s+head)\b/, "hair_buzzcut"],
  [/\b(?:curly|curls)\b/, "hair_curly_long"],
  [/\b(?:wavy|waves?)\b/, "hair_wavy"],
  [/\b(?:bangs|fringe)\b/, "hair_bangs"],
  [/\b(?:long\s+straight|waist[- ]length)\b/, "hair_long_straight"],
  [/\bshort(?:er)?\b[\s\w-]{0,12}\b(?:hair|locks)\b/, "hair_page"],
  [/\blong\b[\s\w-]{0,12}\b(?:hair|locks)\b/, "hair_long"],
  [/\bbald(?:ing)?\b/, ""],
];

const HAIR_STYLES: Rule[] = [
  [["双马尾", "双辫", "twintails", "twin tails", "pigtails"], "hair_pigtails"],
  [["高马尾", "high ponytail"], "hair_high_ponytail"],
  [["马尾", "ponytail", "pony tail"], "hair_ponytail"],
  [["麻花辫", "辫子", "braid", "braids", "plait", "plaits"], "hair_braid"],
  [["丸子头", "发髻", "盘发", "bun", "topknot"], "hair_bangs_bun"],
  [["波波头", "bob cut", "bob"], "hair_bob"],
  [["精灵短发", "pixie"], "hair_pixie"],
  [["爆炸头", "afro"], "hair_afro"],
  [["脏辫", "dreadlocks", "dreads", "cornrows"], "hair_dreadlocks_long"],
  [["莫西干", "mohawk"], "hair_longhawk"],
  [["板寸", "寸头", "buzz cut", "buzzcut", "shaved"], "hair_buzzcut"],
  [["卷发", "卷曲", "curly", "curls"], "hair_curly_long"],
  [["大波浪", "波浪", "wavy", "wave"], "hair_wavy"],
  [["齐刘海", "刘海", "bangs", "fringe"], "hair_bangs"],
  [["及腰", "长直", "long straight", "waist-length"], "hair_long_straight"],
  [["长发", "long hair", "long-haired"], "hair_long"],
  [["短发", "short hair", "short-haired", "lob"], "hair_page"],
  [["光头", "秃", "bald", "shaved head"], ""],
];

const TOPS: Rule[] = [
  [["板甲", "重甲", "plate armour", "plate armor"], "torso_armour_plate"],
  [["锁子甲", "chainmail"], "torso_chainmail"],
  [["皮甲", "轻甲", "leather armour", "leather armor"], "torso_armour_leather"],
  [["铠甲", "盔甲", "护甲", "armor", "armour"], "torso_armour_leather"],
  [["和服", "浴衣", "kimono", "yukata"], "dress_kimono"],
  [["连衣裙", "礼服", "gown", "dress"], "dress_bodice"],
  [["背带裤", "工装", "overalls", "suspenders"], "torso_aprons_overalls"],
  [["马甲", "背心", "vest"], "torso_clothes_vest"],
  [["无袖", "吊带", "sleeveless", "camisole", "tank top"], "torso_clothes_sleeveless2"],
  [["西装", "正装", "blazer", "suit"], "torso_clothes_longsleeve2_buttoned"],
  [["制服", "uniform"], "torso_clothes_longsleeve2_buttoned"],
  [["t恤", "tshirt", "t-shirt", "tee"], "torso_clothes_tshirt"],
  [["衬衫", "衬衣", "shirt", "blouse"], "torso_clothes_shortsleeve"],
  [["毛衣", "卫衣", "针织", "sweater", "hoodie", "knit"], "torso_clothes_longsleeve2"],
  [["长袍", "斗篷", "风衣", "大衣", "外套", "cloak", "robe", "coat", "cape"], "torso_clothes_longsleeve2"],
  [["长袖", "long sleeve", "longsleeve"], "torso_clothes_longsleeve2"],
];

const BOTTOMS: Rule[] = [
  [["连裤袜", "丝袜", "stockings", "tights"], "legs_hose"],
  [["紧身裤", "打底裤", "leggings"], "legs_leggings"],
  [["短裤", "shorts"], "legs_shorts"],
  [["长裙", "裙子", "半身裙", "skirt"], "legs_skirts_plain"],
  [["腿甲", "护腿", "leg armour", "leg armor"], "legs_armour"],
  [["西装裤", "西裤", "正装裤", "formal pants", "dress pants", "suit pants"], "legs_formal"],
  [["牛仔裤", "jeans", "denim"], "legs_pants2"],
  [["长裤", "裤子", "pants", "trousers"], "legs_pants2"],
];

const SHOES: Rule[] = [
  [["靴子", "军靴", "长靴", "boots", "boot"], "feet_boots_basic"],
  [["凉鞋", "拖鞋", "草鞋", "sandals", "flip-flops", "slippers"], "feet_sandals"],
  [["高跟鞋", "high heels", "heels", "stilettos"], "feet_shoes_sara"],
  [["运动鞋", "球鞋", "sneakers", "trainers"], "feet_shoes_revised"],
  [["赤脚", "光脚", "barefoot"], ""],
];

const FACES: Rule[] = [
  [["微笑", "笑", "开心", "愉快", "smile", "smiling", "grin", "happy"], "face_happy"],
  [["悲伤", "难过", "哭", "泪", "sad", "cry", "crying", "tears", "weeping"], "face_sad"],
  [["生气", "愤怒", "恼", "angry", "furious", "irritated"], "face_angry"],
  [["惊讶", "震惊", "吃惊", "shock", "surprised"], "face_shock"],
  [["害羞", "脸红", "羞涩", "blush", "shy", "embarrassed"], "face_blush"],
];

function pickRule(text: string, rules: Rule[], fallback: string): string {
  const { catalog } = loadVocab();
  for (const [words, id] of rules) {
    if (!hasAny(text, words)) continue;
    if (id === "") return ""; // 显式「无」
    if (catalog.items[id]) return id;
  }
  return fallback;
}

function pickColor(text: string, material: string, fallback: string): string {
  return colorFor(text, material) ?? fallback;
}

// ---------------------------------------------------------------- 主入口

const FEMALE_WORDS = [
  "女", "她", "少女", "姑娘", "小姐", "女士", "姐姐", "妹妹", "母亲", "女王", "公主", "女孩",
  "she", "her", "hers", "woman", "women", "female", "girl", "lady", "mother", "sister",
  "daughter", "queen", "princess", "wife", "girlfriend", "madam", "miss", "maiden",
];
const MALE_WORDS = [
  "男", "他", "少年", "先生", "大叔", "哥哥", "弟弟", "父亲", "国王", "王子", "男孩",
  "he", "him", "his", "man", "men", "male", "boy", "gentleman", "father", "brother",
  "son", "king", "prince", "husband", "boyfriend", "sir", "lord", "father",
];
const ELDER_WORDS = ["老者", "老人", "年长", "老翁", "老妪", "白发苍苍", "elderly", "old man", "old woman", "aged"];
const CHILD_WORDS = ["孩童", "儿童", "小孩子", "小孩", "child", "kid", "little girl", "little boy"];

/** 关键词兜底：从卡文字里抓体型 / 发色 / 衣色 / 瞳色 / 部件 */
export function keywordSprite(text: string): PetDescriptor {
  const t = text.toLowerCase();
  const d = defaultSprite();

  // 性别：她 / she 的权重更高（中文「他」在「其他」里会误伤，先排除）
  const noOther = t.replace(/其他/g, "");
  const female = FEMALE_WORDS.reduce((n, w) => n + countOf(noOther, w), 0);
  const male = MALE_WORDS.reduce((n, w) => n + countOf(noOther, w), 0);
  const isMale = male > female;
  d.bodyType = isMale ? "male" : "female";

  const elder = hasAny(t, ELDER_WORDS);
  const child = hasAny(t, CHILD_WORDS);
  const gaunt = hasAny(t, ["消瘦", "枯瘦", "gaunt", "haggard"]);
  const plump = hasAny(t, ["丰满", "发福", "微胖", "plump", "chubby"]);
  if (child) d.items.head = isMale ? "heads_human_male_small" : "heads_human_female_small";
  else if (elder) d.items.head = isMale ? "heads_human_male_elderly" : "heads_human_female_elderly";
  else if (isMale) d.items.head = gaunt ? "heads_human_male_gaunt" : plump ? "heads_human_male_plump" : "heads_human_male";
  else d.items.head = "heads_human_female";

  d.items.face = pickRule(t, FACES, "face_neutral");
  const enHair = HAIR_STYLES_EN.find(([re]) => re.test(t));
  const hairStyle = enHair ? enHair[1] : pickRule(t, HAIR_STYLES, "hair_ponytail");
  if (hairStyle === "") delete d.items.hair;
  else d.items.hair = hairStyle;

  d.items.top = pickRule(t, TOPS, d.items.top ?? "torso_clothes_longsleeve2");
  d.items.bottom = pickRule(t, BOTTOMS, d.items.bottom ?? "legs_pants2");
  const shoes = pickRule(t, SHOES, "feet_shoes_basic");
  if (shoes === "") delete d.items.shoes;
  else d.items.shoes = shoes;

  d.colors.body = pickColor(t, "body", "light");
  d.colors.hair = pickColor(t, "hair", elder ? "white" : "blonde");
  d.colors.cloth = pickColor(t, "cloth", "purple");
  d.colors.eye = pickColor(t, "eye", "green");

  return sanitizeSprite(d);
}

// ---------------------------------------------------------------- 卡文字

/** 把会长卡的可见文字拼成映射用文本（字段越靠前权重越高） */
export function spriteTextFromCard(name: string, personaJson: string): string {
  let p: Record<string, unknown> = {};
  try {
    p = (JSON.parse(personaJson) ?? {}) as Record<string, unknown>;
  } catch {
    p = {};
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join("、") : str(v));
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

  const rows: [string, string, number][] = [
    ["简介", str(p.self_intro), 200],
    ["描述", str(p.description) || str(p.backstory), 1600],
    ["外貌", str(p.appearance), 600],
    ["性格", list(p.personality), 300],
    ["场景", str(p.scenario), 400],
    ["开场白", str(p.first_mes), 700],
    ["台词", str(p.mes_example), 400],
    ["标签", list(p.tags), 300],
    ["备注", str(p.creator_notes), 300],
  ];
  const body = rows
    .filter(([, v]) => v.length > 0)
    .map(([k, v, cap]) => `${k}：${clip(v, cap)}`)
    .join("\n");
  return `名字：${name}\n${body}`;
}
