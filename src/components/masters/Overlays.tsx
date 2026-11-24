"use client";

/**
 * 选会长页的两个全屏浮层：
 * - SwitchingOverlay：交接仪式（切换会长时全局禁用）
 * - TranslatingOverlay：导入卡翻译进度
 *
 * 抽出原因：它们与页面状态无关，只吃几个展示用参数；留在 1000 行的页面里
 * 会让主 JSX 更难读。
 */

export function SwitchingOverlay() {
  return (
    <div
      aria-busy="true"
      className="fixed inset-0 z-50 flex touch-none flex-col items-center justify-center gap-3 backdrop-blur-sm"
      style={{ background: "color-mix(in oklch, var(--bg) 72%, transparent)" }}
    >
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full border border-gold-line font-display text-gold shadow-glow-gold"
      >
        ✦
      </span>
      <p className="font-numeric text-fs-sm tracking-widest text-gold">
        交接仪式进行中……
      </p>
    </div>
  );
}

export function TranslatingOverlay({
  progress,
  elapsed,
  onCancel,
}: {
  progress: { done: number; total: number };
  elapsed: number;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "color-mix(in oklch, var(--bg) 78%, transparent)" }}
    >
      <div className="border-gold-line bg-surface rounded-card w-full max-w-sm border p-4 text-center">
        <p className="text-fs-body">正在翻译角色卡……</p>
        <p className="text-gold font-numeric text-fs-sm mt-1">
          {progress.total > 0 ? `${progress.done} / ${progress.total} 段` : "准备中……"} · {elapsed}s
        </p>
        <div className="bg-surface-3 mt-3 h-2 w-full overflow-hidden rounded-full">
          <div
            className="bg-gold h-full rounded-full transition-all duration-300"
            style={{
              width:
                progress.total > 0
                  ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                  : "10%",
            }}
          />
        </div>
        <p className="text-fs-micro text-faint mt-2 leading-relaxed">
          逐段忠实翻译（含世界书）。用较快的模型会明显更快。
        </p>
        <button
          type="button"
          className="border-border-strong text-muted hover:text-fg rounded-btn mt-3 w-full border py-2 text-fs-sm transition-colors"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}
