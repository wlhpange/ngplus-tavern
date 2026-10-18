"use client";

import { useEffect } from "react";

/**
 * Service Worker 注册（PWA）。
 * 只注册，不做任何 UI——SW 只负责 app shell 缓存（网络优先，断网兜底）。
 *
 * DESIGN-DECISION: 生产环境才注册 SW（「开发模式禁用 SW，生产启用」）。
 * dev 下 next dev 的 HMR/随机端口会让 SW 缓存开发产物、污染调试。
 */
export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((e) => console.warn("[pwa] SW 注册失败", e));
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
