/** 六维属性中文名（面板/任务板共用） */
export const ATTR_LABEL: Record<string, string> = {
  vitality: "体魄",
  mind: "心智",
  willpower: "意志",
  wealth: "财富",
  social: "社交",
  creativity: "创造",
};

export const ATTR_ORDER = [
  "vitality",
  "mind",
  "willpower",
  "wealth",
  "social",
  "creativity",
] as const;

/** 结算流水的类别标签（面板历史 / 对话结算卡片共用） */
export const KIND_LABEL: Record<string, string> = {
  quest_complete: "委托完成",
  bonus: "额外奖励",
  level_up: "升级",
  difficulty_calibration: "难度校准",
  title_grant: "评级突破",
  review_adjustment: "收获复核",
  purchase: "商店购买",
  gift: "礼物赠送",
  skill_purchase: "技能解锁",
  achievement: "成就解锁",
  weekly_boss: "周常讨伐",
  mainline_complete: "主线达成",
};

/** 商品中文名（结算流水展示用） */
export const ITEM_LABEL: Record<string, string> = {
  rest_scroll: "休整卷轴",
  gift_tea: "一盏热茶",
  gift_book: "一本旧书",
  gift_sweet: "一盒点心",
  gift_pocket_watch: "一块旧怀表",
};

/** 商品名兜底：旧库有已下架皮肤的内部 key（如 skin_hearth），不能原样暴露 */
export function itemDisplay(key: string): string {
  if (ITEM_LABEL[key]) return ITEM_LABEL[key];
  if (key.startsWith("skin_")) return "已下架的道具";
  return key;
}

// ============================================================================
// 角色卡文本清洗（导入的生态卡常带 RP 标记与"模板/字段"污染）
// ============================================================================

/** 卡文本里以 `[X=...]` 形式写的"字段块"（如 [Seraphina's Personality= "a","b"]） */
function extractBracketTraits(raw: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]\n]*?[=＝]\s*([^\]\n]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const vals = m[1]
      .split(/[,，]/)
      .map((s) => s.replace(/["'`\s]/g, "").trim())
      .filter(Boolean);
    out.push(...vals);
  }
  return out;
}

/** 把卡面文本压成适合当「简介」的一句人话；纯模板串返回空串 */
export function cleanCardText(raw: string, maxLen = 120): string {
  if (!raw) return "";
  const body = raw.replace(/\r\n?/g, "\n");
  let t = body
    // 摘掉方括号/尖括号"字段块"与宏
    .replace(/\[[^\]\n]{0,200}\]/g, " ")
    .replace(/<[^>\n]{1,40}>/g, " ")
    .replace(/\{\{[^}]*\}\}/g, "");
  // 从显式模板标记处断开（前面若有正文则保留）
  let cutAt = t.length;
  for (const re of [/(?:^|\s)Personality\s*[:=]/i, /\{\{\s*(?:user|char)\s*\}\}/i]) {
    const m = t.match(re);
    if (m && m.index !== undefined) cutAt = Math.min(cutAt, m.index);
  }
  t = t
    .slice(0, cutAt)
    .replace(/^\s*[#]{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\*+/g, "")
    .replace(/[[\]{}<>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[，,;；:：\-—\s]+$/, "")
    .trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).trim() + "…";
  return t;
}

/**
 * 为生态卡生成一句可读的「简介」：
 * 依次尝试 自我推介 → description 正文 → 字段块里的性格词 → 开场白首句。
 * 这样即便卡的 description 全是模板，也不会显示成「X's」。
 */
export function cardIntroText(persona: {
  self_intro?: string;
  description?: string;
  backstory?: string;
  first_mes?: string;
  tags?: string[];
}, maxLen = 120): string {
  const self = persona.self_intro?.trim();
  if (self) return cleanCardText(self, maxLen);

  const desc = persona.description?.trim() || persona.backstory?.trim() || "";
  // 从原始文本抽字段块里的性格词（不依赖清洗后的结果）
  const traits = extractBracketTraits(desc);

  const cleanedDesc = cleanCardText(desc, maxLen);
  // 判定清洗后是否是可读正文：足够长，且不是引号/`:` 碎片这类残留
  const looksJunk =
    cleanedDesc.length < 12 ||
    /^["'`]/.test(cleanedDesc) ||
    /^[:"'\s]/.test(cleanedDesc) ||
    /[："'`]/.test(cleanedDesc.slice(0, 3));
  if (!looksJunk) return cleanedDesc;

  if (traits.length) return `性格：${traits.slice(0, 6).join("、")}`;

  const first = cleanCardText(persona.first_mes ?? "", maxLen);
  if (first.length >= 8) return first;

  if (persona.tags?.length) return `标签：${persona.tags.join("、")}`;
  return cleanedDesc ? `性格：${cleanedDesc}` : "";
}
