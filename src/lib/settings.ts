import * as SecureStore from "expo-secure-store";

import { getSetting, setSetting } from "./db";

/**
 * 文本模型配置：
 * - 地址 / 模型名存在 SQLite（app_settings）
 * - API Key 只进系统安全存储（Android Keystore / iOS Keychain）
 */
export type ApiConfig = {
  baseUrl: string;
  model: string;
  key: string;
};

const KEY = "llm.api_key";
const BASE_URL = "llm.base_url";
const MODEL = "llm.model";

export async function loadConfig(): Promise<ApiConfig> {
  let key = "";
  try {
    key = (await SecureStore.getItemAsync(KEY)) ?? "";
  } catch {
    key = "";
  }
  return {
    baseUrl: getSetting(BASE_URL) ?? "",
    model: getSetting(MODEL) ?? "",
    key,
  };
}

export async function saveConfig(cfg: ApiConfig): Promise<void> {
  setSetting(BASE_URL, cfg.baseUrl.trim());
  setSetting(MODEL, cfg.model.trim());
  const key = cfg.key.trim();
  if (key) await SecureStore.setItemAsync(KEY, key);
  else await SecureStore.deleteItemAsync(KEY);
}

export function isConfigured(cfg: ApiConfig): boolean {
  return Boolean(cfg.baseUrl.trim() && cfg.model.trim());
}
