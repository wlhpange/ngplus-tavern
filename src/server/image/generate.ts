import type { ImageConfig } from "./config";
import { generateImageViaApi } from "./api";

/**
 * 情景配图生成（只走 API）。
 *
 * 不再内置本地推理：所有生图都请求用户在设置里填的 OpenAI 兼容接口
 * （POST {base}/images/generations，兼容 b64_json / url 两种返回）。
 */

/** 生图失败：带中文可读信息，供界面直接展示 */
export class ImageBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageBackendError";
  }
}

/** 情景图提示词：固定风格前缀 + 场景描述。纯函数，便于测试。 */
export function buildScenePrompt(style: string, scene: string): string {
  const s = scene.replace(/\s+/g, " ").trim();
  const parts = [style.trim(), s].filter((p) => p.length > 0);
  return parts.join(", ").slice(0, 1200);
}

export interface GenerateInput {
  prompt: string;
  signal?: AbortSignal;
}

/** 生成一张图，返回图片字节。任何失败都归一成 ImageBackendError。 */
export async function generateImage(
  cfg: Pick<ImageConfig, "apiBaseUrl" | "apiKey" | "apiModel" | "width" | "height">,
  input: GenerateInput,
): Promise<Buffer> {
  try {
    return await generateImageViaApi(cfg, {
      prompt: input.prompt,
      signal: input.signal,
    });
  } catch (e) {
    if (e instanceof ImageBackendError) throw e;
    throw new ImageBackendError(e instanceof Error ? e.message : "生图失败");
  }
}
