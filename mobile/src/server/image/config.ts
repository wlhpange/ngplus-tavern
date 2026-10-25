import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { appSettings } from "../db/schema";
import { getSecret } from "../secure";

/**
 * 情景配图（生图）设置。
 *
 * 只支持 API：请求用户在设置里填的 OpenAI 兼容接口
 * `POST {base}/images/generations`（兼容 b64_json / url 两种返回）。
 * 不再包含本地推理（mflux / LoRA / 量化 / HF 镜像）。
 */

const KEY = {
  enabled: "image.enabled",
  width: "image.width",
  height: "image.height",
  style: "image.style",
  apiBaseUrl: "image.api_base_url",
  apiKey: "image.api_key",
  apiModel: "image.api_model",
} as const;

export interface ImageConfig {
  /** 总开关 */
  enabled: boolean;
  /** 出图尺寸（传给接口的 size） */
  width: number;
  height: number;
  /** 固定风格前缀（锁画风） */
  style: string;
  /** OpenAI 兼容生图接口：地址（到 /v1 为止）、Key、模型名 */
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}

/** 锁画风的默认前缀：插画 + 电影感，跨图观感统一 */
export const DEFAULT_IMAGE_STYLE =
  "cinematic lighting, detailed background, illustration, high quality";

export const DEFAULT_IMAGE_CONFIG: ImageConfig = {
  enabled: false,
  width: 1024,
  height: 1024,
  style: DEFAULT_IMAGE_STYLE,
  apiBaseUrl: "",
  apiKey: "",
  apiModel: "",
};

function readMap(db: Db): Map<string, string> {
  // app_settings 极小（单用户），直接全表读再取用
  const all = db.select().from(appSettings).all();
  return new Map(all.map((r) => [r.key, r.value]));
}

function upsert(db: Db, key: string, value: string): void {
  const existing = db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  if (existing) {
    db.update(appSettings)
      .set({ value, updatedAt: Date.now() })
      .where(eq(appSettings.key, key))
      .run();
  } else {
    db.insert(appSettings)
      .values({ key, value, updatedAt: Date.now() })
      .run();
  }
}

function toInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 面板没设过（DB 里没有这个键）时，回落到环境变量。
 * 只要面板里保存过（哪怕存的是空串），就以面板为准，环境变量不再覆盖。
 */
function pick(m: Map<string, string>, key: string): string {
  return m.get(key) ?? "";
}

export function getImageConfig(db: Db): ImageConfig {
  const m = readMap(db);
  return {
    enabled: m.get(KEY.enabled) === "1",
    width: toInt(pick(m, KEY.width), DEFAULT_IMAGE_CONFIG.width, 256, 2048),
    height: toInt(pick(m, KEY.height), DEFAULT_IMAGE_CONFIG.height, 256, 2048),
    style: pick(m, KEY.style).trim() || DEFAULT_IMAGE_CONFIG.style,
    apiBaseUrl: pick(m, KEY.apiBaseUrl).trim(),
    apiKey: getSecret("image"),
    apiModel: pick(m, KEY.apiModel).trim(),
  };
}

export function setImageSettings(db: Db, patch: Partial<ImageConfig>): ImageConfig {
  if (patch.enabled !== undefined) upsert(db, KEY.enabled, patch.enabled ? "1" : "0");
  if (patch.width !== undefined) upsert(db, KEY.width, String(patch.width));
  if (patch.height !== undefined) upsert(db, KEY.height, String(patch.height));
  if (patch.style !== undefined) upsert(db, KEY.style, patch.style);
  if (patch.apiBaseUrl !== undefined) upsert(db, KEY.apiBaseUrl, patch.apiBaseUrl.trim());
  if (patch.apiModel !== undefined) upsert(db, KEY.apiModel, patch.apiModel.trim());
  return getImageConfig(db);
}
