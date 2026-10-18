import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { appSettings } from "./db/schema";
import {
  createModel,
  isLocalBaseUrl,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_PROVIDER_ID,
  MissingApiKeyError,
  OPENCODE_GO_BASE_URL,
  type ModelConfigInput,
} from "./llm/client";
import { BUILTIN_API_KEYS } from "./llm/keys";
import type { LanguageModel } from "ai";

/**
 * 模型配置解析（V1.5：应用内「模型切换」的数据层）。
 *
 * P11 起简化：各渠道（DeepSeek 官方 / OpenCode Go / 本地 LLM）的 API Key 从
 * **环境变量**读取（见 llm/keys.ts 与 .env.example），前端不再填写 Key 与接口地址，
 * 只负责「换渠道 + 换模型」。数据库里只保留：
 *
 *   设置键：llm.provider / llm.model / llm.judge_model
 *
 * 每个渠道的 baseUrl 与可选模型由 LLM_PROVIDERS 固定给出。
 */

const KEY_MODEL = "llm.model";
const KEY_JUDGE_MODEL = "llm.judge_model";
/** 提供方：deepseek（默认）| opencode-go | local（自定义 API） */
const KEY_PROVIDER = "llm.provider";
/** 自定义 API 的接口地址与 Key（存库；仅本机单用户） */
const KEY_BASE_URL = "llm.base_url";
const KEY_CUSTOM_KEY = "llm.custom_key";

const ALL_KEYS = [KEY_MODEL, KEY_JUDGE_MODEL, KEY_PROVIDER, KEY_BASE_URL, KEY_CUSTOM_KEY];

export type LlmProvider = "deepseek" | "opencode-go" | "local";

/** 是否「自定义 API」渠道（旧 id 沿用 local，显示为「自定义 API」） */
function isCustom(provider: LlmProvider): boolean {
  return provider === LOCAL_LLM_PROVIDER_ID;
}

export interface LlmModelOption {
  id: string;
  label: string;
}

export interface LlmProviderDef {
  id: LlmProvider;
  label: string;
  baseUrl: string;
  /** 注意：Key 不在这里固化，按 provider 运行时从环境变量取（见 apiKeyFor） */
  defaultModel: string;
  models: LlmModelOption[];
}

/** 某渠道的 API Key（运行时从环境变量读取，随 env 变化即时生效） */
export function apiKeyFor(provider: LlmProvider): string {
  return BUILTIN_API_KEYS[provider];
}

/**
 * DeepSeek 官方可选模型。
 * 官方 /models 目前返回 deepseek-flash（展示名 DeepSeek-V4.1-Flash）与
 * deepseek-v4-pro；按需求这里只保留 v4.1 Flash 一档。
 */
export const DEEPSEEK_MODELS: LlmModelOption[] = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash" },
];

/**
 * OpenCode Go 可选模型（前端下拉）。
 * 数据来自 https://opencode.ai/zen/go/v1/models，已剔除需要 /responses 协议的
 * 6 个模型（Grok 4.6/4.7、GPT 5.6/6 Luna、Muse Spark 1.2/1.3 Contributor）——
 * 它们与本项目的 OpenAI 兼容（/chat/completions）接入不兼容。
 */
export const OPENCODE_GO_MODELS: LlmModelOption[] = [
  // DeepSeek 家族
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp" },
  { id: "deepseek-flash", label: "DeepSeek Flash" },
  // 智谱 GLM
  { id: "glm-5.3", label: "GLM-5.3" },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
  { id: "glm-5.2", label: "GLM-5.2" },
  { id: "glm-5.1", label: "GLM-5.1" },
  // Kimi
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
  // Qwen
  { id: "qwen3.8-max", label: "Qwen3.8 Max" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
  { id: "qwen3.7-max", label: "Qwen3.7 Max" },
  { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
  { id: "qwen3.6-plus", label: "Qwen3.6 Plus" },
  // MiniMax
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "minimax-m2.7", label: "MiniMax M2.7" },
  { id: "minimax-m2.5", label: "MiniMax M2.5" },
  // MiMo
  { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro" },
  { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash" },
  { id: "mimo-v2.5-pro", label: "MiMo-V2.5-Pro" },
  { id: "mimo-v2.5", label: "MiMo-V2.5" },
  // LongCat / Hy / 其他
  { id: "longcat-2.0", label: "LongCat-2.0" },
  { id: "longcat-2.5-preview-free", label: "LongCat 2.5 Preview Free" },
  { id: "hy4-preview", label: "Hy4 preview" },
  { id: "hy3", label: "Hy3" },
  { id: "omen-alpha", label: "Omen Alpha" },
  { id: "space-bunny-free", label: "Space Bunny Free" },
];

export const LLM_PROVIDERS: Record<LlmProvider, LlmProviderDef> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    models: DEEPSEEK_MODELS,
  },
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: OPENCODE_GO_BASE_URL,
    defaultModel: "deepseek-v4.1-flash",
    models: OPENCODE_GO_MODELS,
  },
  /**
   * 自定义 API：任何 OpenAI 兼容服务（LM Studio / llama.cpp / Ollama / 自建网关的 /v1）。
   * 接口地址、模型名、Key 都由用户在设置里填（存 app_settings），不写死。
   */
  [LOCAL_LLM_PROVIDER_ID]: {
    id: LOCAL_LLM_PROVIDER_ID,
    label: "自定义 API（OpenAI 兼容）",
    baseUrl: LOCAL_LLM_BASE_URL,
    defaultModel: "",
    models: [],
  },
};

function normalizeProvider(value: string | null | undefined): LlmProvider {
  if (value === "opencode-go" || value === LOCAL_LLM_PROVIDER_ID) return value;
  return "deepseek";
}

export interface LlmConfigState {
  /** 是否有可用 Key（从环境变量读取；未配置时为 false） */
  hasKey: boolean;
  /** Key 掩码，如 oc_****abcd */
  apiKeyMasked: string | null;
  baseUrl: string;
  model: string;
  /** 复核判定器专用模型；空串 = 跟随主模型（判定与生成分离，rpg-design §5） */
  judgeModel: string;
  /** 当前渠道 */
  provider: LlmProvider;
  /** 当前渠道可选模型（前端下拉用） */
  models: LlmModelOption[];
  /** 可选渠道（前端切换用） */
  providers: { id: LlmProvider; label: string }[];
}

function readSettings(db: Db): Map<string, string> {
  const rows = db
    .select()
    .from(appSettings)
    .where(inArray(appSettings.key, ALL_KEYS))
    .all();
  return new Map(rows.map((r) => [r.key, r.value]));
}

function upsert(db: Db, key: string, value: string | null) {
  if (value === null) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
    return;
  }
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

/** 当前渠道下合法的模型：存的值不在清单里就回落到渠道默认 */
function pickModel(def: LlmProviderDef, stored: string | undefined): string {
  return stored && def.models.some((m) => m.id === stored) ? stored : def.defaultModel;
}

/** 判定器模型：未配置/不在清单里 = 跟随主模型（空串） */
function pickJudgeModel(def: LlmProviderDef, stored: string | undefined): string {
  return stored && def.models.some((m) => m.id === stored) ? stored : "";
}

/** Key 掩码：保留前 3 后 4，中间打星；短 Key 全打星 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/** 设置页用：当前渠道 + 模型状态（Key 永不回传明文，只给掩码） */
export function getLlmConfigState(db: Db): LlmConfigState {
  const stored = readSettings(db);
  const provider = normalizeProvider(stored.get(KEY_PROVIDER));
  const def = LLM_PROVIDERS[provider];
  const providers = Object.values(LLM_PROVIDERS).map((p) => ({ id: p.id, label: p.label }));
  if (isCustom(provider)) {
    const baseUrl = stored.get(KEY_BASE_URL)?.trim() || LOCAL_LLM_BASE_URL;
    const apiKey = (stored.get(KEY_CUSTOM_KEY) ?? "").trim();
    return {
      hasKey: Boolean(apiKey),
      apiKeyMasked: apiKey ? maskKey(apiKey) : null,
      baseUrl,
      model: stored.get(KEY_MODEL)?.trim() ?? "",
      judgeModel: "",
      provider,
      models: [],
      providers,
    };
  }
  const apiKey = apiKeyFor(provider);
  return {
    hasKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? maskKey(apiKey) : null,
    baseUrl: def.baseUrl,
    model: pickModel(def, stored.get(KEY_MODEL)),
    judgeModel: pickJudgeModel(def, stored.get(KEY_JUDGE_MODEL)),
    provider,
    models: def.models,
    providers,
  };
}

export interface LlmSettingsPatch {
  /** 切换渠道：模型落到该渠道默认（若本次未显式指定 model） */
  provider?: LlmProvider | null;
  /** null/undefined = 不动；空串 = 清除（回落渠道默认模型） */
  model?: string | null;
  judgeModel?: string | null;
  /** 自定义 API：接口地址 / Key（仅 provider=自定义 时用） */
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** 保存面板设置：空串表示清除该项，undefined 表示不动 */
export function setLlmSettings(db: Db, patch: LlmSettingsPatch): void {
  if (patch.provider !== undefined && patch.provider !== null) {
    const provider = normalizeProvider(patch.provider);
    upsert(db, KEY_PROVIDER, provider);
    // 换渠道时把模型落到该渠道默认，避免留着上一渠道的模型名
    if (patch.model === undefined) {
      upsert(db, KEY_MODEL, LLM_PROVIDERS[provider].defaultModel);
    }
  }
  if (patch.model !== undefined) {
    upsert(db, KEY_MODEL, !patch.model ? null : patch.model.trim() || null);
  }
  if (patch.judgeModel !== undefined) {
    upsert(db, KEY_JUDGE_MODEL, !patch.judgeModel ? null : patch.judgeModel.trim() || null);
  }
  if (patch.baseUrl !== undefined) {
    upsert(db, KEY_BASE_URL, !patch.baseUrl ? null : patch.baseUrl.trim() || null);
  }
  if (patch.apiKey !== undefined) {
    upsert(db, KEY_CUSTOM_KEY, !patch.apiKey ? null : patch.apiKey.trim() || null);
  }
}

export type ModelRole = "main" | "judge";

/**
 * 解析出可用的模型配置（渠道内置 Key + baseUrl，模型取面板设置或渠道默认）。
 * role="judge" 时用判定器专用模型，未单独配置则跟随主模型——
 * 判定与生成分离（rpg-self-improvement-app-design.md §5）：想让复核更深思
 * 可以给判定器配 reasoner 类模型，对话仍走快模型。
 */
export function resolveLlmConfig(db: Db, role: ModelRole = "main"): ModelConfigInput {
  const stored = readSettings(db);
  const provider = normalizeProvider(stored.get(KEY_PROVIDER));
  const def = LLM_PROVIDERS[provider];
  if (isCustom(provider)) {
    const baseUrl = stored.get(KEY_BASE_URL)?.trim() || LOCAL_LLM_BASE_URL;
    const key = (stored.get(KEY_CUSTOM_KEY) ?? "").trim();
    const model = stored.get(KEY_MODEL)?.trim() || "";
    return {
      // 环回地址（本机服务）通常不校验 Key，留空也放行；公网地址没 Key 则报错提示去设置
      apiKey: key || (isLocalBaseUrl(baseUrl) ? "sk-local" : ""),
      baseUrl,
      model,
      provider,
    };
  }
  const mainModel = pickModel(def, stored.get(KEY_MODEL));
  const judge = pickJudgeModel(def, stored.get(KEY_JUDGE_MODEL));
  return {
    apiKey: apiKeyFor(provider),
    baseUrl: def.baseUrl,
    model: role === "judge" ? judge || mainModel : mainModel,
    provider,
  };
}

/**
 * 从数据库解析并构建模型实例；未配置环境变量 Key 时抛 MissingApiKeyError
 * （界面据此提示去 .env 配置）。
 */
export function modelFromDb(db: Db, role: ModelRole = "main"): LanguageModel {
  const config = resolveLlmConfig(db, role);
  if (config.provider === LOCAL_LLM_PROVIDER_ID && !config.model) {
    // 别把空 model 发出去：本地服务会因此卸载当前模型、去加载空名字而报错
    throw new Error("自定义 API 还没填模型名（设置 → 模型与渠道）。");
  }
  if (!config.apiKey) {
    throw new MissingApiKeyError();
  }
  return createModel(config);
}
