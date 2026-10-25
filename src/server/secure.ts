import * as SecureStore from "expo-secure-store";

/**
 * API Key 只进系统安全存储（Android Keystore / iOS Keychain）。
 * 数据库里只留 provider / baseUrl / model 等非机密配置。
 * 模块级 cache 让同步的业务层（resolveLlmConfig）能立即拿到 Key；
 * App 启动时必须先 await hydrateSecrets()。
 */

export const SECRET_KEYS = {
  deepseek: "llm.key.deepseek",
  "opencode-go": "llm.key.opencode-go",
  local: "llm.key.local",
  image: "image.key",
} as const;

export type SecretName = keyof typeof SECRET_KEYS;

const cache = new Map<string, string>();

export async function hydrateSecrets(): Promise<void> {
  await Promise.all(
    Object.entries(SECRET_KEYS).map(async ([name, key]) => {
      try {
        cache.set(name, (await SecureStore.getItemAsync(key)) ?? "");
      } catch {
        cache.set(name, "");
      }
    }),
  );
}

export function getSecret(name: SecretName): string {
  return cache.get(name) ?? "";
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  const v = value.trim();
  cache.set(name, v);
  if (v) await SecureStore.setItemAsync(SECRET_KEYS[name], v);
  else await SecureStore.deleteItemAsync(SECRET_KEYS[name]);
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}
