"use client";

import { useState } from "react";

/**
 * P11 导入角色卡的翻译确认弹窗。
 * 当卡里有外语提示词时弹出：是否翻译成中文（人名保持原文）。翻译忠实原文，
 * 包含R18 内容也如实译出、不做审查。
 */
export default function ImportTranslateDialog({
  cardName,
  fields,
  entries,
  onChoose,
  onCancel,
}: {
  cardName: string;
  /** 需要翻译的卡字段数 */
  fields: number;
  /** 需要翻译的世界书条目数 */
  entries: number;
  onChoose: (translate: boolean) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const parts: string[] = [];
  if (fields > 0) parts.push(`${fields} 处卡字段`);
  if (entries > 0) parts.push(`${entries} 条世界书`);

  function choose(translate: boolean) {
    if (busy) return;
    setBusy(true);
    onChoose(translate);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "color-mix(in oklch, var(--bg) 72%, transparent)" }}
      onClick={onCancel}
    >
      <div
        className="border-gold-line bg-surface rounded-card w-full max-w-sm border p-4"
        style={{ boxShadow: "var(--inset-gold)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-fs-h2">这张卡是外语的</h2>
        <p className="text-fs-sm text-muted mt-2 leading-relaxed">
          「{cardName}」里有 {parts.join("、")} 是外语。
        </p>
        <p className="text-fs-sm text-fg mt-2 leading-relaxed">
          是否把卡里所有提示词翻译成中文？（人名保持原文）
        </p>
        <p className="text-fs-micro text-faint mt-2 leading-relaxed">
          翻译会忠实原文：格式、标记、语气都保留；原文若含R18 内容也如实译出，不做删改。
        </p>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => choose(true)}
            className="bg-gold text-on-gold rounded-btn w-full py-2 text-fs-sm font-medium transition-transform active:translate-y-px disabled:opacity-40"
          >
            {busy ? "处理中……" : "翻译成中文并导入"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => choose(false)}
            className="border-border-strong rounded-btn w-full border py-2 text-fs-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
          >
            保持原文导入
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="text-fs-micro text-muted hover:text-fg w-full py-1 transition-colors disabled:opacity-40"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
