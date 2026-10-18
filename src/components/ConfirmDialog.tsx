"use client";

/**
 * 轻量确认弹窗（V3）：
 * 用于「再来一次」这类会产生实际状态变更的操作——先问一句，确认才执行。
 * 样式沿用星穹秘契：暗底 + 金/发丝线；点击遮罩或取消关闭。
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
        className="border-border bg-surface w-full max-w-sm rounded-card border p-4 shadow-overlay"
        style={{ boxShadow: "var(--shadow-2), var(--inset-gold)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-display text-fs-h3">{title}</p>
        {description && (
          <p className="text-muted mt-1.5 text-fs-sm leading-relaxed">{description}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="border-border-strong rounded-btn border px-3.5 py-1.5 text-fs-sm transition-colors hover:bg-surface-2 disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="bg-gold text-on-gold rounded-btn px-3.5 py-1.5 text-fs-sm font-medium transition-transform active:translate-y-px disabled:opacity-40"
          >
            {busy ? "……" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
