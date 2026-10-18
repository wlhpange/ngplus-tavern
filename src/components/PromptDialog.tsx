"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 轻量输入弹窗：替代 window.prompt，沿用星穹秘契样式（暗底 + 金/发丝线）。
 * 回车提交、点遮罩或取消关闭。
 */
export default function PromptDialog({
  title,
  label,
  initialValue = "",
  placeholder,
  maxLength = 40,
  confirmLabel = "确定",
  busy = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    if (busy) return;
    onSubmit(value.trim());
  }

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center px-6"
      style={{ background: "color-mix(in oklch, var(--bg) 78%, transparent)" }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="border-border bg-surface w-full max-w-sm rounded-card border p-4"
        style={{ boxShadow: "var(--shadow-2), var(--inset-gold)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-display text-fs-h3">{title}</p>
        {label && <p className="text-muted mt-1.5 text-fs-sm">{label}</p>}
        <input
          ref={inputRef}
          className="border-border-strong bg-surface-2 text-fg rounded-btn mt-3 w-full border px-3 py-2 text-fs-sm outline-none focus:border-accent"
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="border-border-strong rounded-btn border px-3.5 py-1.5 text-fs-sm transition-colors hover:bg-surface-2 disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="bg-gold text-on-gold rounded-btn px-3.5 py-1.5 text-fs-sm font-medium transition-transform active:translate-y-px disabled:opacity-40"
          >
            {busy ? "……" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
