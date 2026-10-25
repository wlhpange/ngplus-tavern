import type { ImageConfig } from "./config";
import { decodeBase64 } from "../util/bytes";

/**
 * 自定义生图接口（OpenAI 兼容 `POST {base}/images/generations`）。
 * 兼容两种返回：`data[0].b64_json` 或 `data[0].url`。
 * 地址/模型/Key 都在「设置 → 生图」里填。
 */
export async function generateImageViaApi(
  cfg: Pick<ImageConfig, "apiBaseUrl" | "apiKey" | "apiModel" | "width" | "height">,
  input: { prompt: string; signal?: AbortSignal },
): Promise<Uint8Array> {
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("还没填生图接口地址（设置 → 生图）。");
  if (!cfg.apiModel.trim()) throw new Error("还没填生图模型名（设置 → 生图）。");

  const res = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.apiModel,
      prompt: input.prompt,
      n: 1,
      size: `${cfg.width}x${cfg.height}`,
      response_format: "b64_json",
    }),
    signal: input.signal,
  });

  const text = await res.text();
  let json: {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
    message?: string;
  } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 200);
    throw new Error(`生图接口返回 ${res.status}：${msg}`);
  }
  const item = json?.data?.[0];
  if (!item) throw new Error("生图接口没有返回图片数据。");
  if (item.b64_json) return decodeBase64(item.b64_json);
  if (item.url) {
    const r2 = await fetch(item.url, { signal: input.signal });
    if (!r2.ok) throw new Error(`下载生成的图片失败：${r2.status}`);
    return new Uint8Array(await r2.arrayBuffer());
  }
  throw new Error("生图接口返回里既没有 b64_json 也没有 url。");
}
