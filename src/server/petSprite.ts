import { eq } from "drizzle-orm";

import type { Db } from "./db";
import { masters } from "./db/schema";
import { setMasterSprite } from "./masters";
import { resolveLlmConfig } from "./modelConfig";
import { generateText, type LlmConfig } from "./llm/client";
import type { PetDescriptor } from "@/weblib/petCatalog";
import {
  defaultSprite,
  keywordSprite,
  loadVocab,
  sanitizeSprite,
  spriteTextFromCard,
  type SpriteSource,
} from "./petDesign";

export { defaultSprite, keywordSprite, sanitizeSprite, spriteTextFromCard };

/**
 * 会长 → 像素小人形象参数的映射。
 *
 * 不用图像生成：只把「角色卡文字」翻译成「部件 + 颜色」参数（从固定枚举里选）。
 * 优先用 LLM（跨供应商稳的 generateText + JSON 解析），失败 / 无 Key 时退回关键词规则。
 * 结果再由 catalog / palettes 校验收敛，保证一定可渲染。
 */

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
  "你是「二周目协会」的形象设计师。用户给出一个会长的角色卡文字。",
  "你的任务：从给定的固定部件/颜色清单里，为 ta 挑一套最贴合描述的像素小人形象。",
  "优先看「描述 / 外貌 / 开场白」里写到的性别、年龄感、发型、发色、瞳色、衣服与鞋；没写到的才用默认值。",
  "只输出一个 JSON 对象，不要任何解释或代码围栏。",
  "字段：bodyType（female/male）、items（body/head/face/hair/top/bottom/shoes 各选一个 id）、colors（body/hair/cloth/eye 各选一个颜色名）。",
  "只能从下面清单里取值，不要编造；确实没有头发的角色，hair 可以留 null。",
].join("\n");

async function llmSprite(model: LlmConfig, text: string): Promise<PetDescriptor> {
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
  const shape = `{"bodyType":"female","items":{"body":"body","head":"heads_human_female","face":"face_neutral","hair":"hair_ponytail","top":"torso_clothes_longsleeve2","bottom":"legs_pants2","shoes":"feet_shoes_basic"},"colors":{"body":"light","hair":"blonde","cloth":"purple","eye":"green"}}`;

  const prompt = [
    `【角色卡】\n${text.slice(0, 4000)}`,
    `【可选的 bodyType】female（女）/ male（男）`,
    `【槽位与可选部件】\n${slotLines.join("\n")}`,
    `【可选颜色】\n${colorLines.join("\n")}`,
    `只输出一个 JSON 对象，结构示例：\n${shape}`,
  ].join("\n\n");

  const { text: out } = await generateText(model, {
    system: SYSTEM,
    prompt,
    maxTokens: 900,
    timeoutMs: 120_000,
  });
  return withAutoDefaults(sanitizeSprite(extractJson(out) as Partial<PetDescriptor>));
}

/** 自动生成时补上被模型漏掉的衣物槽位；手改（无）不受影响——那条路径不经过这里 */
function withAutoDefaults(d: PetDescriptor): PetDescriptor {
  const fallback = defaultSprite();
  const items = { ...d.items };
  for (const slot of ["top", "bottom", "shoes"] as const) {
    if (!items[slot]) items[slot] = fallback.items[slot];
  }
  return { ...d, items };
}

/** 由卡文字得到形象参数：LLM 优先，失败退关键词 */
export async function mapSpriteFromText(
  model: LlmConfig | null,
  text: string,
): Promise<{ sprite: PetDescriptor; source: SpriteSource }> {
  if (model?.apiKey) {
    try {
      return { sprite: await llmSprite(model, text), source: "llm" };
    } catch {
      /* 落回关键词 */
    }
  }
  return { sprite: keywordSprite(text), source: "rules" };
}

/** 导入/新增后自动生成形象并落库；返回 descriptor 与来源 */
export async function autoMapSpriteForMaster(
  db: Db,
  userId: string,
  masterId: string,
): Promise<{ sprite: PetDescriptor; source: SpriteSource }> {
  const row = db.select().from(masters).where(eq(masters.id, masterId)).get();
  if (!row) throw new Error("会长不存在");
  const text = spriteTextFromCard(row.name, row.personaJson);
  let model: LlmConfig | null = null;
  try {
    model = resolveLlmConfig(db);
  } catch {
    model = null;
  }
  const result = await mapSpriteFromText(model, text);
  setMasterSprite(db, userId, masterId, JSON.stringify(result.sprite));
  return result;
}
