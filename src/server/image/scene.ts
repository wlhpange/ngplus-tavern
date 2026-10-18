import { generateText } from "ai";
import type { Db } from "../db";
import { modelFromDb } from "../modelConfig";

/**
 * 情景图「场景提炼」。
 *
 * 直接把整段角色扮演回复丢给生图模型会污染画面（台词、*动作*、状态数值、系统文字）。
 * 这里用**文字渠道的 LLM**把消息改写成一句纯视觉描述（场景/人物外形/姿势/光线/氛围），
 * 再交给生图。提炼失败一律回退原文，绝不阻断生图。
 *
 * 复用现有 LLM 渠道（modelFromDb）：文字走哪个模型，提炼就走哪个。
 */

const SCENE_SYSTEM =
  "你是资深分镜师／剧照摄影指导。把一段角色扮演对话，提炼成**一帧**可以直接拿去 AI 绘画的画面描述。";

/** 提炼用的提示词（纯函数，便于测试）。context = 人物外形/衣着/世界书命中条目。 */
export function buildExtractionPrompt(
  content: string,
  context?: string,
  opts: { adult?: boolean } = {},
): string {
  const lines = [
    "把下面这一整段角色扮演回复，提炼成**一帧**用于 AI 绘画的「画面描述」。",
    "这段回复可能包含多个场景、多个段落：挑其中最主要、最有画面感的一幕来画（一般是回复的主体），不要东拼西凑。",
    "如果**最后一段发生了场景切换**（时间、地点、人物大幅变化，或明显是在为下一轮做铺垫），就**忽略最后一段**，只画它之前的主场景。",
    "只描述看得见的东西。下面是思考清单（在心里想清楚就好，最终只输出精简到 50 字以内的一帧）：",
    "① 动作与姿势（最重要）：谁在做什么、身体朝向、手/腿/腰的位置、与对方或环境的相对位置、是否正在动作中（如转身、俯身、被按在墙上、伸手去解衣扣）。",
    "② 表情与神态：眼神方向、嘴角、脸红、呼吸、汗水。",
    "③ 人物外形与衣着状态：发型、穿着、衣着是否凌乱/半褪/湿透/敞开，肌肤与身体线条。",
    "④ 环境与道具：地点、家具、凌乱的床单、洒落的杯子等能交代情境的东西。",
    "⑤ 光线与氛围：光源方向、明暗、色调、天气、时间。",
    "⑥ 镜头感：景别（特写/近景/中景/全身）、机位与视角（俯拍/仰拍/过肩/侧面）。",
  ];
  const ctx = context?.trim();
  if (ctx) {
    lines.push(
      "",
      "参考设定（用于人物外形、衣着、风格；只取与画面相关的，不要照抄、不要提到设定本身）：",
      ctx.slice(0, 1200),
    );
  }
  lines.push(
    "要求：",
    "- 只输出画面描述本身，不要台词、不要旁白、不要解释、不要引号、不要分点。",
    "- 不要出现数值、状态条、系统提示、括号里的备注。",
    "- **整段不超过 50 个字**（中文字符计）。话越少越好，生图模型压力更小。",
    "- 只写**一帧 / 一个瞬间**：定格里的人物在做什么。不要写连续动作、不要写情节推进、不要交代前因后果。",
    "- 在这 50 字内按主次取舍，优先保留：动作/姿势 + 表情 + 一个最有辨识度的细节（衣着状态或环境/光线）。用具体名词和动词，避免「美丽」「性感」这类空泛词。",
    "- 保留人物姓名。",
  );
  if (opts.adult) {
    lines.push(
      "- 如实定格画面：亲密、裸露、情色或暴力的内容照实写出来（身体部位、接触、姿态、表情与反应），不要审查、不要淡化、不要用含蓄词替代，也不要把画面「安全化」。",
    );
  }
  lines.push("", "回复：", content);
  return lines.join("\n");
}

type SceneCall = (prompt: string, signal: AbortSignal) => Promise<string>;

/** 默认提炼：走文字渠道的 LLM */
function llmSceneCall(db: Db): SceneCall {
  return async (prompt, signal) => {
    const { text } = await generateText({
      model: modelFromDb(db),
      system: SCENE_SYSTEM,
      prompt,
      maxOutputTokens: 120,
      abortSignal: signal,
    });
    return text;
  };
}

/** 去掉模型可能加的首尾引号/空白 */
function tidy(s: string): string {
  return s.trim().replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, "");
}

/** 画面描述硬上限（字符数，中文按字计）：超出即截断，保证生图提示词足够短 */
export const MAX_SCENE_CHARS = 50;

function capScene(s: string): string {
  const t = s.trim();
  return t.length <= MAX_SCENE_CHARS ? t : t.slice(0, MAX_SCENE_CHARS).trim();
}

/**
 * 提炼场景描述。任何失败（未配置 LLM / 超时 / 空结果）都回退为压缩后的原文。
 * 结果一律截到 {@link MAX_SCENE_CHARS} 字以内（一帧描述，不写连续动作）。
 * @param call 可注入（测试用）；默认走 LLM。
 * @param context 人物外形/衣着/世界书命中条目。
 * @param adult 允许R18 内容时，如实描述亲密/裸露画面、不审查。
 */
export async function extractScene(
  db: Db,
  content: string,
  signal?: AbortSignal,
  call?: SceneCall,
  context?: string,
  adult = false,
): Promise<string> {
  const raw = content.replace(/\s+/g, " ").trim();
  if (!raw) return raw;

  const signals = [AbortSignal.timeout(20_000)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  try {
    const run = call ?? llmSceneCall(db);
    const out = tidy(await run(buildExtractionPrompt(raw, context, { adult }), combined));
    return out ? capScene(out) : capScene(raw);
  } catch {
    return capScene(raw);
  }
}
