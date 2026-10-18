"use client";

/**
 * 聊天记录（归档页，2026-09-27 定案）
 * - 对话主界面只显示最近三天的内容，更早的全部在这里
 * - 按月分组、按日分隔；支持关键词搜索与类型筛选（全部/对话/结算）
 * - 分页加载（每页 40 条，游标由服务端返回）
 *
 * 手机端长列表优化（P11）：
 * - 日分隔吸顶；右侧「日期索引」浮条可点按跳转
 * - 日期跳转（选某天，从那天往回加载），免去一页页翻
 * - 触底自动加载下一页；搜索改为输入即搜（防抖）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SettlementCard, { type SettlementCardData } from "@/components/SettlementCard";

interface ApiMessage {
  id: string;
  role: "user" | "master";
  content: string;
  sender: string;
  createdAt: number;
}

type RecordItem =
  | { type: "message"; message: ApiMessage }
  | { type: "settlement"; settlement: SettlementCardData };

type Kind = "all" | "chat" | "settlement";

interface RecordsResponse {
  items?: (
    | { type: "message"; id: string; role: "user" | "master"; content: string; sender: string; createdAt: number }
    | { type: "settlement"; settlement: SettlementCardData }
  )[];
  hasMore?: boolean;
  nextBefore?: number | null;
}

const KIND_TABS: { key: Kind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "chat", label: "对话" },
  { key: "settlement", label: "结算" },
];

const PAGE_SIZE = 40;

function monthLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${monthKey(ts)}-${d.getDate()}`;
}

function itemTime(it: RecordItem): number {
  return it.type === "message" ? it.message.createdAt : it.settlement.createdAt;
}

/** <input type="date"> 的值（本地时区）→ 当天 00:00 的时间戳 */
function dateInputToStart(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

export default function RecordsPage() {
  const [items, setItems] = useState<RecordItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  /** 日期跳转：只取该时刻之前的内容（某天 0 点 = 从那天开始往回看） */
  const [dateBefore, setDateBefore] = useState<number | null>(null);
  const [dateValue, setDateValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (opts: { reset: boolean; before?: number | null; q: string; kind: Kind }) => {
      const seq = ++requestSeq.current;
      if (opts.reset) {
        setItems(null);
        setError(null);
      }
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), kind: opts.kind });
        if (opts.before) params.set("before", String(opts.before));
        if (opts.q) params.set("q", opts.q);
        const res = await fetch(`/api/records?${params.toString()}`);
        const d = (await res.json()) as RecordsResponse;
        if (seq !== requestSeq.current) return; // 过期响应丢弃
        const batch: RecordItem[] = (d.items ?? []).map((it) =>
          it.type === "message"
            ? { type: "message", message: it }
            : { type: "settlement", settlement: it.settlement },
        );
        setItems((prev) => (opts.reset ? batch : [...(prev ?? []), ...batch]));
        setHasMore(Boolean(d.hasMore));
        setNextBefore(d.nextBefore ?? null);
        if (opts.reset) {
          // 新的列表从顶部看起
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: 0 });
          });
        }
      } catch {
        if (seq !== requestSeq.current) return;
        if (opts.reset) setItems([]);
        setError("记录没能取出来，稍后再试。");
      }
    },
    [],
  );

  // 首次加载；筛选 / 搜索 / 日期跳转变化时重置
  useEffect(() => {
    load({ reset: true, before: dateBefore, q: query, kind });
  }, [load, query, kind, dateBefore]);

  // 输入即搜（防抖 300ms）
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  function loadMore() {
    if (!hasMore || nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    load({ reset: false, before: nextBefore, q: query, kind }).finally(() =>
      setLoadingMore(false),
    );
  }

  // 触底自动加载（保留「加载更早」按钮兜底）
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: "200px" },
    );
    io.observe(target);
    return () => io.disconnect();
    // loadMore 依赖 hasMore/nextBefore/loadingMore，故一并入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, nextBefore, loadingMore, query, kind, dateBefore]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setQuery(searchInput.trim());
  }

  /** 右侧日期索引：已加载的日期（新→旧，去重） */
  const dayAnchors: { key: string; label: string }[] = [];
  if (items) {
    const seen = new Set<string>();
    for (const it of items) {
      const k = dayKey(itemTime(it));
      if (!seen.has(k)) {
        seen.add(k);
        const d = new Date(itemTime(it));
        dayAnchors.push({ key: k, label: String(d.getDate()) });
      }
    }
  }

  function jumpToDay(key: string) {
    document.getElementById(`day_${key}`)?.scrollIntoView({ block: "start" });
  }

  // 按月/日分组渲染（倒序：最新在前）
  const rendered: React.ReactNode[] = [];
  let lastMonth = "";
  let lastDay = "";
  for (const it of items ?? []) {
    const ts = itemTime(it);
    const mk = monthKey(ts);
    if (mk !== lastMonth) {
      rendered.push(
        <p
          key={`m_${mk}`}
          className="text-gold font-display pt-2 text-fs-h3"
        >
          {monthLabel(ts)}
        </p>,
      );
      lastMonth = mk;
      lastDay = "";
    }
    const dk = dayKey(ts);
    if (dk !== lastDay) {
      rendered.push(
        <div
          key={`d_${dk}`}
          id={`day_${dk}`}
          className="bg-bg sticky top-0 z-10 flex items-center gap-3 py-1"
        >
          <span className="border-border flex-1 border-t" />
          <span className="text-fs-micro text-faint tracking-widest">
            {dayLabel(ts)}
          </span>
          <span className="border-border flex-1 border-t" />
        </div>,
      );
      lastDay = dk;
    }
    if (it.type === "settlement") {
      rendered.push(
        <SettlementCard key={`s_${it.settlement.id}`} s={it.settlement} />,
      );
      continue;
    }
    const m = it.message;
    rendered.push(
      m.role === "user" ? (
        <div key={m.id} className="flex justify-end">
          <div className="border-accent-line bg-accent-soft rounded-card rounded-br-chip min-w-0 max-w-[80%] border px-3.5 py-2 text-fs-sm leading-relaxed whitespace-pre-wrap break-words">
            {m.content}
          </div>
        </div>
      ) : (
        <div key={m.id} className="flex items-start gap-2">
          <div className="border-border bg-surface-3 text-muted mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px]">
            {(m.sender || "会").slice(0, 1)}
          </div>
          <div className="min-w-0">
            <p className="text-fs-micro text-muted mb-0.5 tracking-widest">
              {m.sender || "会长"}
            </p>
            <div className="border-border bg-surface rounded-card rounded-tl-chip max-w-[85%] border px-3.5 py-2 text-fs-sm whitespace-pre-wrap leading-relaxed break-words">
              {m.content}
            </div>
          </div>
        </div>
      ),
    );
  }

  return (
    <main className="bg-bg text-fg relative mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-fs-h1 leading-tight">聊天记录</h1>
            <p className="text-fs-micro text-muted">
              三天之前的对话都在这里，按月归档
            </p>
          </div>
          <Link
            href="/"
            className="border-border-strong rounded-btn shrink-0 border px-3 py-1.5 text-fs-sm transition-colors hover:bg-surface-2"
          >
            返回对话
          </Link>
        </div>

        {/* 搜索 + 类型筛选 */}
        <form onSubmit={submitSearch} className="mt-3 flex gap-2">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="输入即搜：委托名、会长说过的话……"
            className="border-border-strong bg-surface-2 text-fs-sm placeholder:text-faint focus:border-accent rounded-pill flex-1 border px-3.5 py-2 outline-none transition-colors"
          />
          <button
            type="submit"
            className="border-border-strong rounded-pill shrink-0 border px-3.5 py-2 text-fs-sm transition-colors hover:bg-surface-2"
          >
            搜索
          </button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {KIND_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setKind(t.key)}
              className={`rounded-full border px-3 py-1 text-fs-micro transition-colors ${
                kind === t.key
                  ? "border-gold-line bg-gold-soft text-gold"
                  : "border-border text-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
          {/* 日期跳转 */}
          <label className="border-border text-fs-micro text-muted ml-auto flex items-center gap-1 rounded-full border px-2 py-1">
            跳到
            <input
              type="date"
              value={dateValue}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setDateValue(e.target.value);
                setDateBefore(dateInputToStart(e.target.value));
              }}
              className="bg-transparent text-fs-micro text-fg outline-none"
            />
          </label>
          {dateBefore != null && (
            <button
              type="button"
              onClick={() => {
                setDateValue("");
                setDateBefore(null);
              }}
              className="text-fs-micro text-accent"
            >
              回最新
            </button>
          )}
          {query && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setQuery("");
              }}
              className="text-fs-micro text-faint hover:text-fg"
            >
              清除搜索：{query}
            </button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {items === null && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            正在翻档案室……
          </p>
        )}
        {rendered}
        {items !== null && items.length === 0 && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            {query || kind !== "all" || dateBefore != null
              ? "没有找到匹配的记录。换个关键词或筛选试试。"
              : "档案室还是空的。"}
          </p>
        )}
        {items !== null && hasMore && (
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
        {/* 触底哨兵：滚到这里自动加载下一页 */}
        <div ref={sentinelRef} aria-hidden className="h-px w-full" />
        {items !== null && !hasMore && items.length > 0 && (
          <p className="text-fs-micro text-faint pt-1 text-center">
            到这里就是协会最早的记录了
          </p>
        )}
        {error && (
          <p className="border-danger text-danger-text rounded-tile border px-3 py-2 text-fs-meta">
            {error}
          </p>
        )}
      </div>

      {/* 右侧日期索引浮条：点按跳到那一天 */}
      {dayAnchors.length >= 4 && (
        <div className="absolute right-0.5 top-1/2 z-20 flex max-h-[60%] -translate-y-1/2 flex-col items-center gap-0.5 overflow-y-auto">
          {dayAnchors.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => jumpToDay(d.key)}
              className="text-fs-micro text-faint hover:text-accent w-5 py-0.5 text-center font-numeric tabular-nums"
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
