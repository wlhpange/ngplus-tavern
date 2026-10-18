"use client";

/**
 * 技能树（V3）
 * - 解锁条件 = 金币 + 总等级（目录在 economy_config.skills）
 * - 效果由引擎在结算/签到处读取生效，页面只负责展示与解锁
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { playCue } from "@/lib/audio";

interface SkillView {
  key: string;
  name: string;
  desc: string;
  cost_gold: number;
  min_level: number;
  effect: { type: string; value: number };
  owned: boolean;
  levelOk: boolean;
  affordable: boolean;
}

interface SkillsResponse {
  gold: number;
  totalLevel: number;
  skills: SkillView[];
}

export default function SkillsPage() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("技能树没能取出来，刷新一下再试。"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function unlock(skill: SkillView) {
    if (busy) return;
    setBusy(skill.key);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillKey: skill.key }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? "协会那边没办成，请稍后再试。");
        return;
      }
      playCue("purchase");
      setFlash(`点亮了「${skill.name}」。它已经生效了。`);
      load();
    } catch {
      setError("协会那边没办成，请稍后再试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="bg-bg text-fg mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-fs-h1 leading-tight">技能树</h1>
            <p className="text-fs-micro text-muted">
              金币 + 等级解锁，点亮后一直生效
            </p>
          </div>
          <Link
            href="/character"
            className="border-border-strong rounded-btn shrink-0 border px-3 py-1.5 text-fs-sm transition-colors hover:bg-surface-2"
          >
            返回面板
          </Link>
        </div>
        {data && (
          <p className="mt-2 font-numeric text-fs-micro tabular-nums text-faint">
            当前 Lv.{data.totalLevel} · 金币 {data.gold} · 已点亮{" "}
            {data.skills.filter((s) => s.owned).length}/{data.skills.length}
          </p>
        )}
      </header>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {!data && !error && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            正在翻技能树……
          </p>
        )}
        {flash && (
          <p className="border-gold-line bg-gold-soft text-gold rounded-tile border px-3 py-2 text-fs-meta">
            {flash}
          </p>
        )}
        {data?.skills.map((s) => {
          const requirement = s.owned
            ? "已点亮"
            : !s.levelOk
              ? `需要 Lv.${s.min_level}`
              : !s.affordable
                ? "金币不够"
                : null;
          return (
            <article
              key={s.key}
              className={`rounded-card border p-3.5 transition-colors ${
                s.owned
                  ? "border-gold-line bg-surface"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
              style={
                s.owned
                  ? { boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--gold) 14%, transparent)" }
                  : undefined
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-display text-fs-h3">
                    {s.name}
                    {s.owned && (
                      <span className="text-gold ml-2 font-numeric text-fs-micro">
                        ✓ 已点亮
                      </span>
                    )}
                  </h3>
                  <p className="text-muted mt-0.5 text-fs-sm leading-relaxed">
                    {s.desc}
                  </p>
                  <p className="font-numeric text-fs-micro tabular-nums text-faint">
                    {s.cost_gold} 金币 · 需要 Lv.{s.min_level}
                  </p>
                </div>
                {!s.owned && (
                  <button
                    type="button"
                    disabled={busy !== null || !s.levelOk || !s.affordable}
                    onClick={() => unlock(s)}
                    className={`rounded-btn shrink-0 border px-3 py-1.5 text-fs-sm transition-colors disabled:opacity-50 ${
                      s.levelOk && s.affordable
                        ? "border-gold-line bg-gold-soft text-gold hover:brightness-110"
                        : "border-border text-faint"
                    }`}
                  >
                    {busy === s.key ? "……" : requirement ?? "解锁"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {error && (
          <p className="border-danger text-danger-text rounded-tile border px-3 py-2 text-fs-meta">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
