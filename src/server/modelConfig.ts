import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { appSettings } from "./db/schema";
import {
  isLocalBaseUrl,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_PROVIDER_ID,
  MissingApiKeyError,
  OPENCODE_GO_BASE_URL,
  type LlmConfig,
  type ModelConfigInput,
} from "./llm/client";
import { getSecret, maskKey, type SecretName } from "./secure";

/** 渠道与模型配置。Key 不落库，只从 SecureStore 读取。 */

const KEY_MODEL = "llm.model";
const KEY_JUDGE_MODEL = "llm.judge_model";
const KEY_PROVIDER = "llm.provider";
const KEY_BASE_URL = "llm.base_url";
const ALL_KEYS = [KEY_MODEL, KEY_JUDGE_MODEL, KEY_PROVIDER, KEY_BASE_URL];

export type LlmProvider = "deepseek" | "opencode-go" | "local";

export interface LlmModelOption {
  id: string;
  label: string;
}

export interface LlmProviderDef {
  id: LlmProvider;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: LlmModelOption[];
}

export const DEEPSEEK_MODELS: LlmModelOption[] = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash" },
];

export const OPENCODE_GO_MODELS: LlmModelOption[] = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-flash", label: "DeepSeek Flash" },
  { id: "glm-5.3", label: "GLM-5.3" },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
  { id: "glm-5.2", label: "GLM-5.2" },
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
  { id: "qwen3.8-max", label: "Qwen3.8 Max" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro" },
  { id: "longcat-2.0", label: "LongCat-2.0" },
  { id: "hy3", label: "Hy3" },
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
  hasKey: boolean;
  apiKeyMasked: string | null;
  baseUrl: string;
  model: string;
  judgeModel: string;
  provider: LlmProvider;
  models: LlmModelOption[];
  providers: { id: LlmProvider; label: string }[];
}

function readSettings(db: Db): Map<string, string> {
  const rows = db.select().from(appSettings).where(inArray(appSettings.key, ALL_KEYS)).all();
  return new Map(rows.map((r) => [r.key, r.value]));
}

function upsert(db: Db, key: string, value: string | null) {
  if (value === null) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
    return;
  }
  const existing = db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).get();
  if (existing) {
    db.update(appSettings).set({ value, updatedAt: Date.now() }).where(eq(appSettings.key, key)).run();
  } else {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() }).run();
  }
}

function pickModel(def: LlmProviderDef, stored: string | undefined): string {
  return stored && def.models.some((m) => m.id === stored) ? stored : def.defaultModel;
}

function pickJudgeModel(def: LlmProviderDef, stored: string | undefined): string {
  return stored && def.models.some((m) => m.id === stored) ? stored : "";
}

export function providerKeyName(provider: LlmProvider): SecretName {
  return provider;
}

export function getLlmConfigState(db: Db): LlmConfigState {
  const stored = readSettings(db);
  const provider = normalizeProvider(stored.get(KEY_PROVIDER));
  const def = LLM_PROVIDERS[provider];
  const providers = Object.values(LLM_PROVIDERS).map((p) => ({ id: p.id, label: p.label }));
  const key = getSecret(provider);
  if (provider === LOCAL_LLM_PROVIDER_ID) {
    return {
      hasKey: Boolean(key),
      apiKeyMasked: key ? maskKey(key) : null,
      baseUrl: stored.get(KEY_BASE_URL)?.trim() || LOCAL_LLM_BASE_URL,
      model: stored.get(KEY_MODEL)?.trim() ?? "",
      judgeModel: "",
      provider,
      models: [],
      providers,
    };
  }
  return {
    hasKey: Boolean(key),
    apiKeyMasked: key ? maskKey(key) : null,
    baseUrl: def.baseUrl,
    model: pickModel(def, stored.get(KEY_MODEL)),
    judgeModel: pickJudgeModel(def, stored.get(KEY_JUDGE_MODEL)),
    provider,
    models: def.models,
    providers,
  };
}

export interface LlmSettingsPatch {
  provider?: LlmProvider | null;
  model?: string | null;
  judgeModel?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export function setLlmSettings(db: Db, patch: LlmSettingsPatch): void {
  if (patch.provider !== undefined && patch.provider !== null) {
    const provider = normalizeProvider(patch.provider);
    upsert(db, KEY_PROVIDER, provider);
    if (patch.model === undefined) upsert(db, KEY_MODEL, LLM_PROVIDERS[provider].defaultModel);
  }
  if (patch.model !== undefined) upsert(db, KEY_MODEL, !patch.model ? null : patch.model.trim() || null);
  if (patch.judgeModel !== undefined) upsert(db, KEY_JUDGE_MODEL, !patch.judgeModel ? null : patch.judgeModel.trim() || null);
  if (patch.baseUrl !== undefined) upsert(db, KEY_BASE_URL, !patch.baseUrl ? null : patch.baseUrl.trim() || null);
  // apiKey 由调用方写入 SecureStore（setSecret），这里不落库。
}

export type ModelRole = "main" | "judge";

export function resolveLlmConfig(db: Db, role: ModelRole = "main"): LlmConfig {
  const stored = readSettings(db);
  const provider = normalizeProvider(stored.get(KEY_PROVIDER));
  const def = LLM_PROVIDERS[provider];
  if (provider === LOCAL_LLM_PROVIDER_ID) {
    const baseUrl = stored.get(KEY_BASE_URL)?.trim() || LOCAL_LLM_BASE_URL;
    const key = getSecret(provider);
    const model = stored.get(KEY_MODEL)?.trim() || "";
    return {
      apiKey: key || (isLocalBaseUrl(baseUrl) ? "sk-local" : ""),
      baseUrl,
      model,
      provider,
    };
  }
  const mainModel = pickModel(def, stored.get(KEY_MODEL));
  const judge = pickJudgeModel(def, stored.get(KEY_JUDGE_MODEL));
  return {
    apiKey: getSecret(provider),
    baseUrl: def.baseUrl,
    model: role === "judge" ? judge || mainModel : mainModel,
    provider,
  };
}

export function requireLlmConfig(db: Db, role: ModelRole = "main"): LlmConfig {
  const config = resolveLlmConfig(db, role);
  if (config.provider === LOCAL_LLM_PROVIDER_ID && !config.model) {
    throw new Error("自定义 API 还没填模型名（设置 → 模型与渠道）。");
  }
  if (!config.apiKey) throw new MissingApiKeyError();
  return config;
}

export type { ModelConfigInput };
