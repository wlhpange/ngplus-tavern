import { useCallback, useSyncExternalStore } from "react";

import { getUiPref, subscribeUiPref } from "./service";

/**
 * 读取「本机 UI 偏好」（SQLite app_settings 里的 ui.*），并在任意页面 setUiPref 后自动重渲染。
 *
 * 不要用 useState + getUiPref 在挂载时读一次：标签页常驻不卸载，去设置页关掉开关再切回来，
 * 画面会停在旧值，只有重启 App 才生效。
 */
export function useUiPref(key: string, fallback: string): string {
  const subscribe = useCallback((onChange: () => void) => subscribeUiPref(key, onChange), [key]);
  const snapshot = useCallback(() => {
    try {
      return getUiPref(key, fallback);
    } catch {
      return fallback;
    }
  }, [key, fallback]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 开关型偏好（存 "1" / "0"）。 */
export function useUiPrefOn(key: string, fallback = true): boolean {
  return useUiPref(key, fallback ? "1" : "0") !== "0";
}
