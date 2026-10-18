"use client";

/**
 * 委托档案室（2026-09-27 档案化）
 * 告示板只保留本月完成记录，更早的都在这里：按月分组、可搜标题、分页加载、可一键重挂。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ATTR_LABEL } from "@/lib/labels";

interface Quest {
  id: string;
  title: string;
  description: string | null;
  type: "daily" | "once" | "weekly" | "mainline" | "mainline_milestone";
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  difficulty: number;
  status: string;
  completedAt: number | null;
}

const TYPE_LABEL: Record<Quest["type"], string> = {
  daily: "日常",
  weekly: "每周",
  once: "一次性",
  mainline: "主线",
  mainline_milestone: "里程碑",
};

const PAGE_SIZE = 50;

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function monthLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

export default function ArchivePage() {
  const [quests, setQuests] = useState<Quest[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [repeating, setRepeating] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Quest | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (opts: { reset: boolean; before?: number | null; q: string }) => {
      const seq = ++requestSeq.current;
      if (opts.reset) {
        setQuests(null);
        setError(null);
      }
      try {
        const params = new URLSearchParams({
          status: "completed",
          limit: String(PAGE_SIZE),
        });
        if (opts.before) params.set("before", String(opts.before));
        if (opts.q) params.set("q", opts.q);
        const res = await fetch(`/api/quests?${params.toString()}`);
        const d = (await res.json()) as {
          quests?: Quest[];
          hasMore?: boolean;
          nextBefore?: number | null;
        };
        if (seq !== requestSeq.current) return;
        setQuests((prev) =>
          opts.reset ? (d.quests ?? []) : [...(prev ?? []), ...(d.quests ?? [])],
        );
        setHasMore(Boolean(d.hasMore));
        setNextBefore(d.nextBefore ?? null);
      } catch {
        if (seq === requestSeq.current && opts.reset) setQuests([]);
        setError("档案没能取出来，稍后再试。");
      }
    },
    [],
  );

  useEffect(() => {
    load({ reset: true, q: query });
  }, [load, query]);

  function loadMore() {
    if (!hasMore || nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    load({ reset: false, before: nextBefore, q: query }).finally(() =>
      setLoadingMore(false),
    );
  }

  async function repeat(q: Quest) {
    if (repeating) return;
    setRepeating(q.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/quests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repeat", questId: q.id }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? "重挂没能办成，稍后再试。");
        return;
      }
      setConfirming(null);
      setMessage(`「${q.title}」重新挂上了，直接进行中。`);
    } catch {
      setError("重挂没能办成，稍后再试。");
    } finally {
      setRepeating(null);
    }
  }

  // 按月分组（倒序：新月份在前）
  const rendered: React.ReactNode[] = [];
  let lastMonth = "";
  for (const q of quests ?? []) {
    const ts = q.completedAt ?? 0;
    const mk = monthKey(ts);
    if (mk !== lastMonth) {
      rendered.push(
        <p key={`m_${mk}`} className="text-gold font-display pt-2 text-fs-h3">
          {monthLabel(ts)}
        </p>,
      );
      lastMonth = mk;
    }
    rendered.push(
      <article
        key={q.id}
        className="border-border bg-surface hover:border-border-strong rounded-card border p-3 transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-fs-h3 truncate">{q.title}</h3>
            <p className="font-numeric text-fs-micro tabular-nums text-muted">
              {TYPE_LABEL[q.type]} · 完成于 {formatDate(ts)} · 难度{" "}
              {q.difficulty.toFixed(1)}
            </p>
          </div>
          {q.type !== "mainline" && q.type !== "mainline_milestone" && (
            <button
              type="button"
              disabled={repeating !== null}
              onClick={() => setConfirming(q)}
              className="border-accent-line text-accent hover:bg-accent-soft rounded-btn shrink-0 border px-2.5 py-1 text-fs-meta transition-colors disabled:opacity-40"
            >
              {repeating === q.id ? "重挂中……" : "再来一次"}
            </button>
          )}
        </div>
        <p className="mt-1 text-fs-micro text-faint">
          {ATTR_LABEL[q.primaryAttr] ?? q.primaryAttr} ×{q.primaryWeight.toFixed(1)}
          {q.secondaryAttr
            ? ` ｜ ${ATTR_LABEL[q.secondaryAttr] ?? q.secondaryAttr} ×${(q.secondaryWeight ?? 0).toFixed(1)}`
            : ""}
        </p>
      </article>,
    );
  }

  return (
    <main className="bg-bg text-fg mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-fs-h1 leading-tight">委托档案室</h1>
            <p className="text-fs-micro text-muted">
              更早的完成记录都在这里，按月归档
            </p>
          </div>
          <Link
            href="/quests"
            className="border-border-strong rounded-btn shrink-0 border px-3 py-1.5 text-fs-sm transition-colors hover:bg-surface-2"
          >
            返回告示板
          </Link>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(searchInput.trim());
          }}
          className="mt-3 flex gap-2"
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜委托标题……"
            className="border-border-strong bg-surface-2 text-fs-sm placeholder:text-faint focus:border-accent rounded-pill flex-1 border px-3.5 py-2 outline-none transition-colors"
          />
          <button
            type="submit"
            className="border-border-strong rounded-pill shrink-0 border px-3.5 py-2 text-fs-sm transition-colors hover:bg-surface-2"
          >
            搜索
          </button>
        </form>
      </header>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {quests === null && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            正在翻档案室……
          </p>
        )}
        {message && (
          <p className="border-gold-line bg-gold-soft text-gold rounded-tile border px-3 py-2 text-fs-meta">
            {message}
          </p>
        )}
        {rendered}
        {quests !== null && quests.length === 0 && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            {query ? "没找到这个标题的委托。" : "档案室还空着。"}
          </p>
        )}
        {quests !== null && hasMore && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="border-border text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-meta transition-colors disabled:opacity-50"
            >
              {loadingMore ? "……" : "加载更早"}
            </button>
          </div>
        )}
        {quests !== null && !hasMore && quests.length > 0 && (
          <p className="text-fs-micro text-faint pt-1 text-center">
            到这里就是最早的记录了
          </p>
        )}
        {error && (
          <p className="border-danger text-danger-text rounded-tile border px-3 py-2 text-fs-meta">
            {error}
          </p>
        )}
      </div>

      {/* 再来一次：先确认，确认后直接挂成进行中 */}
      {confirming && (
        <ConfirmDialog
          title={`再来一次「${confirming.title}」？`}
          description="按同样的属性与难度重挂一件，确认后直接进入「进行中」，不用再去对话里接受。"
          confirmLabel="挂上"
          busy={repeating === confirming.id}
          onConfirm={() => repeat(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </main>
  );
}
