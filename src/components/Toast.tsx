"use client";

import { useEffect, useState } from "react";

/**
 * 全局轻提示（Toast）：保存成功 / 失败统一走这里，替换各页零散的 savedText/error 文本。
 * 用法：在任意客户端组件里 `toast("已保存")` / `toast("网络不通", "err")`。
 * 需在根布局挂载一次 `<Toaster />`。
 */

export type ToastKind = "ok" | "err";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

type Listener = (t: ToastItem) => void;
let listeners: Listener[] = [];
let seq = 1;

/** 弹一条提示（默认成功样式）。可在任意客户端组件调用。 */
export function toast(text: string, kind: ToastKind = "ok"): void {
  const item: ToastItem = { id: seq++, text, kind };
  for (const l of listeners) l(item);
}

const TTL = 2400;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (t) => {
      setItems((prev) => [...prev, t]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== t.id));
      }, TTL);
    };
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-[95] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-pill border px-4 py-2 text-fs-sm ${
            t.kind === "err"
              ? "border-danger bg-surface text-danger-text"
              : "border-gold-line bg-surface text-gold"
          }`}
          style={{ boxShadow: "var(--shadow-2)" }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
