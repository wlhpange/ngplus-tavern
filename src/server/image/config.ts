import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { appSettings } from "../db/schema";

/**
 * 本地生图（情景配图）设置。
 *
 * 后端：mflux（MLX 原生，Apple Silicon），命令行调用，无常驻服务。
 * 默认模型 FLUX.2 klein 4B；默认 4-bit 量化（16GB 内存更稳）。
 *
 * 下载走国内 HF 镜像（HF_ENDPOINT），避免消耗 VPN 流量；可在设置里改。
 */

const KEY = {
  enabled: "image.enabled",
  /** 生图后端：mflux（本地 MLX 命令行）| api（自定义 OpenAI 兼容生图接口） */
  backend: "image.backend",
  model: "image.model",
  quantize: "image.quantize",
  mfluxBin: "image.mflux_bin",
  hfEndpoint: "image.hf_endpoint",
  steps: "image.steps",
  width: "image.width",
  height: "image.height",
  style: "image.style",
  loraPath: "image.lora_path",
  loraScale: "image.lora_scale",
  loraModel: "image.lora_model",
  loraTrigger: "image.lora_trigger",
  apiBaseUrl: "image.api_base_url",
  apiKey: "image.api_key",
  apiModel: "image.api_model",
} as const;

export interface ImageConfig {
  /** 总开关 */
  enabled: boolean;
  /** 后端：mflux = 本地 MLX；api = 自定义 OpenAI 兼容生图接口 */
  backend: "mflux" | "api";
  /** 模型 id（见 mflux.ts 的 MFLUX_MODELS） */
  model: string;
  /** 量化位宽：4 或 8（0 = 不量化） */
  quantize: 4 | 8 | 0;
  /** mflux 可执行文件完整路径；留空自动探测 */
  mfluxBin: string;
  /** HuggingFace 端点（国内镜像），注入给 mflux 进程的 HF_ENDPOINT */
  hfEndpoint: string;
  steps: number;
  width: number;
  height: number;
  /** 固定风格前缀（锁画风） */
  style: string;
  /** LoRA：HF 仓库 id 或本地 .safetensors 路径；留空 = 不挂 LoRA */
  loraPath: string;
  /** LoRA 权重 */
  loraScale: number;
  /** 这个 LoRA 只属于哪个模型 id（切到别的模型时不挂，避免错配）；留空 = 不限 */
  loraModel: string;
  /** LoRA 触发词（很多 LoRA 需要它才明显生效）；挂 LoRA 时追加在提示词最前 */
  loraTrigger: string;
  /** 自定义生图接口：地址（到 /v1 为止）、Key、模型名 */
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}

/** 锁画风的默认前缀：插画 + 电影感，跨图观感统一 */
export const DEFAULT_IMAGE_STYLE =
  "cinematic lighting, detailed background, illustration, high quality";

/** 默认 HF 国内镜像：mflux 下载模型时走这里，不消耗 VPN 流量 */
export const DEFAULT_HF_ENDPOINT = "https://hf-mirror.com";

export const DEFAULT_IMAGE_CONFIG: ImageConfig = {
  enabled: false,
  backend: "mflux",
  model: "flux2-klein-4b",
  quantize: 4,
  mfluxBin: "",
  hfEndpoint: DEFAULT_HF_ENDPOINT,
  steps: 4,
  width: 832,
  height: 1216,
  style: DEFAULT_IMAGE_STYLE,
  loraPath: "",
  loraScale: 0.8,
  loraModel: "",
  loraTrigger: "",
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

function toQuantize(v: string | undefined): 4 | 8 | 0 {
  return v === "8" ? 8 : v === "0" ? 0 : 4;
}

function toFloat(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat(v ?? "");
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 面板没设过（DB 里没有这个键）时，回落到环境变量——供启动器预设默认值（如随生图一起装的 LoRA）。
 * 只要面板里保存过（哪怕存的是空串），就以面板为准，环境变量不再覆盖。
 */
function pick(m: Map<string, string>, key: string, envName: string): string {
  const v = m.get(key);
  return v !== undefined ? v : process.env[envName] ?? "";
}

export function getImageConfig(db: Db): ImageConfig {
  const m = readMap(db);
  return {
    enabled: m.has(KEY.enabled) ? m.get(KEY.enabled) === "1" : process.env.IMAGE_ENABLED === "1",
    backend: pick(m, KEY.backend, "IMAGE_BACKEND") === "api" ? "api" : "mflux",
    model: m.get(KEY.model)?.trim() || process.env.IMAGE_MODEL?.trim() || DEFAULT_IMAGE_CONFIG.model,
    quantize: toQuantize(m.get(KEY.quantize)),
    mfluxBin: m.get(KEY.mfluxBin) ?? "",
    hfEndpoint: m.get(KEY.hfEndpoint)?.trim() ?? DEFAULT_HF_ENDPOINT,
    steps: toInt(m.get(KEY.steps), DEFAULT_IMAGE_CONFIG.steps, 1, 50),
    width: toInt(m.get(KEY.width), DEFAULT_IMAGE_CONFIG.width, 256, 1536),
    height: toInt(m.get(KEY.height), DEFAULT_IMAGE_CONFIG.height, 256, 1536),
    style: m.get(KEY.style) ?? DEFAULT_IMAGE_CONFIG.style,
    loraPath: pick(m, KEY.loraPath, "IMAGE_LORA_PATH").trim(),
    loraScale: toFloat(pick(m, KEY.loraScale, "IMAGE_LORA_SCALE"), DEFAULT_IMAGE_CONFIG.loraScale, 0, 2),
    loraModel: pick(m, KEY.loraModel, "IMAGE_LORA_MODEL").trim(),
    loraTrigger: pick(m, KEY.loraTrigger, "IMAGE_LORA_TRIGGER").trim(),
    apiBaseUrl: pick(m, KEY.apiBaseUrl, "IMAGE_API_BASE_URL").trim(),
    apiKey: pick(m, KEY.apiKey, "IMAGE_API_KEY").trim(),
    apiModel: pick(m, KEY.apiModel, "IMAGE_API_MODEL").trim(),
  };
}

export function setImageSettings(db: Db, patch: Partial<ImageConfig>): ImageConfig {
  if (patch.enabled !== undefined) upsert(db, KEY.enabled, patch.enabled ? "1" : "0");
  if (patch.backend !== undefined) upsert(db, KEY.backend, patch.backend === "api" ? "api" : "mflux");
  if (patch.model !== undefined) upsert(db, KEY.model, patch.model.trim());
  if (patch.quantize !== undefined) upsert(db, KEY.quantize, String(patch.quantize));
  if (patch.mfluxBin !== undefined) upsert(db, KEY.mfluxBin, patch.mfluxBin.trim());
  if (patch.hfEndpoint !== undefined) upsert(db, KEY.hfEndpoint, patch.hfEndpoint.trim());
  if (patch.steps !== undefined) upsert(db, KEY.steps, String(patch.steps));
  if (patch.width !== undefined) upsert(db, KEY.width, String(patch.width));
  if (patch.height !== undefined) upsert(db, KEY.height, String(patch.height));
  if (patch.style !== undefined) upsert(db, KEY.style, patch.style);
  if (patch.loraPath !== undefined) upsert(db, KEY.loraPath, patch.loraPath.trim());
  if (patch.loraScale !== undefined) upsert(db, KEY.loraScale, String(patch.loraScale));
  if (patch.loraModel !== undefined) upsert(db, KEY.loraModel, patch.loraModel.trim());
  if (patch.loraTrigger !== undefined) upsert(db, KEY.loraTrigger, patch.loraTrigger.trim());
  if (patch.apiBaseUrl !== undefined) upsert(db, KEY.apiBaseUrl, patch.apiBaseUrl.trim());
  if (patch.apiKey !== undefined) upsert(db, KEY.apiKey, patch.apiKey.trim());
  if (patch.apiModel !== undefined) upsert(db, KEY.apiModel, patch.apiModel.trim());
  return getImageConfig(db);
}
