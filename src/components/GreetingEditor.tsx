"use client";

import { useEffect, useState } from "react";

/**
 * P9 开场白编辑（会长卡字段）：
 * - 首条开场白（first_mes）+ 若干备选开场白（alternate_greetings）
 * - 保存后写回会长卡；下次换会长/重开会话时生效
 */
export default function GreetingEditor({
  masterId,
  masterName,
  onClose,
  onSaved,
}: {
  masterId: string;
  masterName: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [first, setFirst] = useState("");
  const [alternates, setAlternates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/masters/card?masterId=${encodeURIComponent(masterId)}`)
      .then((r) => r.json())
      .then((d: { card?: { first_mes?: string; alternate_greetings?: string[] } }) => {
        setFirst(d.card?.first_mes ?? "");
        setAlternates(d.card?.alternate_greetings ?? []);
      })
      .catch(() => setError("读不到这位会长的卡。"))
      .finally(() => setLoading(false));
  }, [masterId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/masters/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterId,
          patch: { first_mes: first, alternate_greetings: alternates },
        }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "保存失败。");
        return;
      }
      onSaved?.();
      onClose();
    } catch {
      setError("网络不通，保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: "color-mix(in oklch, var(--bg) 60%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="border-border bg-surface max-h-[85dvh] w-full max-w-md space-y-3 overflow-y-auto rounded-t-card border p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-fs-h2">编辑开场白</h2>
          <button className="text-fs-meta text-muted hover:text-fg" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="text-fs-micro text-faint leading-relaxed">
          「{masterName}」见你时说的第一句话。首条是默认；备选会在聊天页「换一条」时轮流使用。
        </p>

        {loading ? (
          <p className="text-muted py-6 text-center text-sm">读取中……</p>
        ) : (
          <>
            <label className="block">
              <span className="text-fs-micro text-muted">首条开场白</span>
              <textarea
                className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 min-h-20 w-full border px-3 py-2 text-fs-sm leading-relaxed outline-none"
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                placeholder="ta 见到你说的第一句话"
              />
            </label>

            <div className="space-y-2">
              <span className="text-fs-micro text-muted">备选开场白</span>
              {alternates.map((g, i) => (
                <div key={i} className="flex gap-2">
                  <textarea
                    className="border-border-strong bg-surface-2 text-fg rounded-btn min-h-14 flex-1 border px-3 py-2 text-fs-sm leading-relaxed outline-none"
                    value={g}
                    onChange={(e) =>
                      setAlternates((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder={`备选 ${i + 1}`}
                  />
                  <button
                    type="button"
                    className="text-muted hover:text-danger-text shrink-0 self-start px-1 py-2 text-fs-micro"
                    onClick={() => setAlternates((prev) => prev.filter((_, j) => j !== i))}
                  >
                    删
                  </button>
                </div>
              ))}
              {alternates.length < 8 && (
                <button
                  type="button"
                  className="border-accent-line text-accent hover:bg-accent-soft rounded-btn w-full border border-dashed py-2 text-fs-sm transition-colors"
                  onClick={() => setAlternates((prev) => [...prev, ""])}
                >
                  + 加一条备选
                </button>
              )}
            </div>

            {error && (
              <p className="border-danger text-danger-text rounded-tile border px-3 py-2 text-fs-sm">
                {error}
              </p>
            )}

            <button
              type="button"
              disabled={saving}
              className="bg-accent text-on-accent rounded-btn w-full py-2 text-fs-sm font-medium disabled:opacity-40"
              onClick={save}
            >
              {saving ? "保存中……" : "保存"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
