"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import RadarChart from "@/components/RadarChart";
import { ATTR_LABEL, ATTR_ORDER, KIND_LABEL, itemDisplay } from "@/lib/labels";

interface AttrSummary {
  xp: number;
  level: number;
  xpToNext: number;
}

interface SettlementRecord {
  id: string;
  kind: string;
  questTitle: string | null;
  completionRatio: number | null;
  xpAwarded: number;
  goldAwarded: number;
  attrSplit: Record<string, number>;
  adjustments: Record<string, unknown> | null;
  createdAt: number;
}

interface MonthSummary {
  xp: number;
  gold: number;
  count: number;
}

interface AchievementView {
  key: string;
  name: string;
  desc: string;
  hidden?: boolean;
  owned: boolean;
  unlockedAt: number | null;
}

interface WeeklyBossView {
  week: string;
  name: string;
  desc: string;
  progress: number;
  target: number;
  claimed: boolean;
  reward: { gold: number; item: string; item_count: number };
}

interface CharacterData {
  totalXp: number;
  totalLevel: number;
  xpToNextLevel: number;
  nextLevelXpRequired: number;
  rank: string;
  rankBadge: {
    current: string;
    next: { rank: string; levelsNeeded: number } | null;
  };
  ranks: { rank: string; minLevel: number }[];
  gold: number;
  attrs: Record<string, AttrSummary>;
  titles: string[];
  monthSummary: MonthSummary;
  skillSummary: { owned: number; total: number };
  achievements: AchievementView[];
  achievementSummary: { owned: number; total: number };
  weeklyBoss: WeeklyBossView;
}

/** 月账单筛选（kinds 参数，逗号分隔可多选） */
const BILL_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "quest_complete,mainline_complete", label: "委托" },
  { key: "review_adjustment", label: "复核" },
  { key: "purchase", label: "购买" },
  { key: "gift", label: "赠送" },
  { key: "skill_purchase", label: "技能" },
  { key: "title_grant", label: "称号" },
];

const TITLE_LABEL: Record<string, string> = {
  streak_7: "七日不熄",
  first_gold: "第一桶金",
};

/** 称号章内字符：段位称号显示段位字母，其余取标签首字 */
function titleSeal(key: string, label: string): string {
  if (key.startsWith("rank_")) return key.slice(5).toUpperCase();
  return label.slice(0, 1);
}

/** 称号 key 兜底显示：数据库还有 rank_x、attr_x 等程序化授予的 key，不能原样暴露 */
function titleDisplay(key: string): string {
  if (TITLE_LABEL[key]) return TITLE_LABEL[key];
  if (key.startsWith("rank_")) return `突破徽记 · ${key.slice(5).toUpperCase()}`;
  const attrMatch = key.match(/^attr_([a-z]+)_(\d+)$/);
  if (attrMatch) {
    return `${ATTR_LABEL[attrMatch[1]] ?? attrMatch[1]} Lv${attrMatch[2]}`;
  }
  return key.replaceAll("_", " ");
}

/** 六维分类色（§3.7，数据编码专用；token 名是 --attr-will 而非 --attr-willpower） */
const ATTR_COLOR: Record<string, string> = {
  vitality: "var(--attr-vitality)",
  mind: "var(--attr-mind)",
  willpower: "var(--attr-will)",
  wealth: "var(--attr-wealth)",
  social: "var(--attr-social)",
  creativity: "var(--attr-create)",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 进度条（§7.4）：6px 圆角轨道 + 属性分类色填充 + 末梢辉光；填充色是数据编码 */
function ProgressBar({
  ratio,
  color = "var(--accent)",
}: {
  ratio: number;
  color?: string;
}) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--fg)_8%,transparent)]">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
          background: color,
          boxShadow: "0 0 8px color-mix(in oklch, currentColor 40%, transparent)",
        }}
      />
    </div>
  );
}

/** 评级蜡封徽章（§7.6）：--danger 径向蜡体 + --gold 内圈 + 宋体大字母 */
function RankSeal({ rank }: { rank: string }) {
  return (
    <span
      aria-label={`当前评级 ${rank}`}
      className="flex h-24 w-24 shrink-0 rotate-[-8deg] items-center justify-center rounded-full font-display text-[44px] font-bold text-gold"
      style={{
        background: "radial-gradient(circle at 30% 25%, var(--danger-soft), var(--danger) 68%)",
        boxShadow:
          "inset 0 0 0 3px var(--gold-line), inset 0 0 0 1px color-mix(in oklch, var(--gold) 70%, transparent), var(--shadow-1)",
      }}
    >
      {rank}
    </span>
  );
}

export default function CharacterPage() {
  const [data, setData] = useState<CharacterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 月账单（V3 档案化）：分页 + 类型筛选
  const [bill, setBill] = useState<SettlementRecord[] | null>(null);
  const [billHasMore, setBillHasMore] = useState(false);
  const [billNext, setBillNext] = useState<number | null>(null);
  const [billKind, setBillKind] = useState("all");
  const [billLoading, setBillLoading] = useState(false);

  const loadBill = useCallback(
    async (opts: { reset: boolean; before?: number | null; kind: string }) => {
      if (opts.reset) setBill(null);
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (opts.before) params.set("before", String(opts.before));
        if (opts.kind !== "all") params.set("kinds", opts.kind);
        const res = await fetch(`/api/character/settlements?${params.toString()}`);
        const d = (await res.json()) as {
          settlements?: SettlementRecord[];
          hasMore?: boolean;
          nextBefore?: number | null;
        };
        setBill((prev) =>
          opts.reset ? (d.settlements ?? []) : [...(prev ?? []), ...(d.settlements ?? [])],
        );
        setBillHasMore(Boolean(d.hasMore));
        setBillNext(d.nextBefore ?? null);
      } catch {
        if (opts.reset) setBill([]);
        setError("账本没能取出来，稍后再试。");
      }
    },
    [],
  );

  useEffect(() => {
    fetch("/api/character")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError("档案没能取出来，刷新一下再试。"));
  }, []);

  useEffect(() => {
    loadBill({ reset: true, kind: billKind });
  }, [loadBill, billKind]);

  function loadMoreBill() {
    if (!billHasMore || billNext == null || billLoading) return;
    setBillLoading(true);
    loadBill({ reset: false, before: billNext, kind: billKind }).finally(() =>
      setBillLoading(false),
    );
  }

  if (!data) {
    return (
      <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
        <header className="border-b border-border px-4 py-3">
          <h1 className="font-display text-fs-h1 leading-tight">角色面板</h1>
        </header>
        <p className="mt-10 text-center text-fs-sm text-muted">
          {error ?? "正在翻你的冒险者档案……"}
        </p>
        <BottomNav />
      </main>
    );
  }

  const levelProgress =
    1 - data.xpToNextLevel / data.nextLevelXpRequired;
  const currentRankIndex = data.ranks.findIndex(
    (r) => r.rank === data.rankBadge.current,
  );
  // 称号墙只放突破徽记等荣誉（成就进图鉴）
  const rankTitles = data.titles.filter((t) => !t.startsWith("ach_"));

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
      <header className="border-b border-border px-4 py-3">
        <div>
          <h1 className="font-display text-fs-h1 leading-tight">角色面板</h1>
          <p className="font-numeric text-fs-micro tracking-wide text-muted">
            协会卷宗室 · 与结算记录同源
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {/* 冒险者档案：评级蜡封 + 等级 + 评级带 + 金币（§7.1/§7.6） */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <p className="font-numeric text-fs-micro uppercase tracking-widest text-faint">
            冒险者档案
          </p>
          <div className="mt-3 flex items-center gap-4">
            <RankSeal rank={data.rankBadge.current} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-fs-display text-gold">
                  Lv.{data.totalLevel}
                </span>
                <span className="font-numeric text-fs-micro tabular-nums text-muted">
                  距下一级 {data.xpToNextLevel} XP
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <ProgressBar ratio={levelProgress} />
                <span className="font-numeric text-fs-micro tabular-nums text-muted">
                  {Math.round(levelProgress * 100)}%
                </span>
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-fs-meta text-muted">金币</span>
                <span className="font-numeric text-fs-h3 font-semibold tabular-nums text-gold">
                  {data.gold}
                </span>
              </div>
            </div>
          </div>

          {/* 评级带 F→S：走过=金线框，当前=金实心，未至=弱文 */}
          <div className="mt-4">
            <div className="flex gap-1.5">
              {data.ranks.map((r, i) => {
                const active = r.rank === data.rankBadge.current;
                const passed = !active && currentRankIndex >= 0 && i < currentRankIndex;
                return (
                  <span
                    key={r.rank}
                    className={`flex h-8 flex-1 items-center justify-center rounded-chip font-numeric text-sm font-bold ${
                      active
                        ? "bg-gold text-on-gold"
                        : passed
                          ? "border border-gold-line text-gold"
                          : "bg-surface-2 text-faint"
                    }`}
                  >
                    {r.rank}
                  </span>
                );
              })}
            </div>
            <p className="mt-1.5 font-numeric text-fs-micro tabular-nums text-muted">
              {data.rankBadge.next
                ? `下一次突破：${data.rankBadge.current} → ${data.rankBadge.next.rank}（还需 ${data.rankBadge.next.levelsNeeded} 级）`
                : "已达最高评级 S · 突破圆满"}
            </p>
          </div>

          <div className="mt-3 flex justify-end border-t border-border pt-3">
            <Link
              href="/shop"
              className="rounded-btn border border-gold-line px-3 py-1.5 text-fs-sm text-gold transition-colors hover:bg-gold-soft"
            >
              协会商店 →
            </Link>
          </div>
        </section>

        {/* 周常 Boss（V3）：本周悬赏 + 进度 + 奖励预览 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-display text-fs-h2 text-gold">本周悬赏</h2>
            <span
              className={`font-numeric text-fs-micro tabular-nums ${
                data.weeklyBoss.claimed ? "text-gold" : "text-faint"
              }`}
            >
              {data.weeklyBoss.claimed
                ? "已达成"
                : `${data.weeklyBoss.progress}/${data.weeklyBoss.target}`}
            </span>
          </div>
          <p className="mt-1 text-fs-sm">{data.weeklyBoss.name}</p>
          <p className="text-fs-micro text-muted">{data.weeklyBoss.desc}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--fg)_8%,transparent)]">
            <div
              className="bg-gold h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    (data.weeklyBoss.progress / Math.max(1, data.weeklyBoss.target)) * 100,
                  ),
                )}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-fs-micro text-faint">
            奖励：{data.weeklyBoss.reward.gold} 金币 + 道具 ×
            {data.weeklyBoss.reward.item_count}（达标自动入袋）
          </p>
        </section>

        {/* 属性星图（§7.5）：星座雷达 + 圆心唯一 KPI，数值放外侧属性条 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="mb-2 font-display text-fs-h2 text-gold">属性星图</h2>
          <RadarChart
            centerLabel={`Lv.${data.totalLevel}`}
            values={ATTR_ORDER.map((k) => ({
              key: k,
              level: data.attrs[k]?.level ?? 1,
            }))}
          />
          <div className="mt-3 space-y-2">
            {ATTR_ORDER.map((k) => {
              const a = data.attrs[k];
              if (!a) return null;
              const required = a.level * 100 + 50; // 150 + 100×(N-1)
              return (
                <div key={k} className="flex items-center gap-2 text-fs-meta">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: ATTR_COLOR[k] }}
                  />
                  <span className="w-8 shrink-0 text-fg">{ATTR_LABEL[k]}</span>
                  <span className="w-10 shrink-0 font-numeric tabular-nums text-muted">
                    Lv.{a.level}
                  </span>
                  <ProgressBar ratio={1 - a.xpToNext / required} color={ATTR_COLOR[k]} />
                  <span className="w-14 shrink-0 text-right font-numeric tabular-nums text-muted">
                    差 {a.xpToNext}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 称号墙（§7.8）：已获得金描边章；未解锁条目不在数据里，不虚构 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="mb-2 font-display text-fs-h2 text-gold">称号</h2>
          {rankTitles.length === 0 ? (
            <p className="text-fs-meta text-muted">
              还没有称号。完成委托、保持连击，协会会为你授勋。
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {data.titles.map((t) => {
                const label = titleDisplay(t);
                return (
                  <div
                    key={t}
                    className="flex items-center gap-2.5 rounded-tile border border-gold-line bg-gold-soft px-3 py-2.5"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gold-line font-display text-sm text-gold">
                      {titleSeal(t, label)}
                    </span>
                    <span className="min-w-0 truncate font-display text-fs-sm text-fg">
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 图鉴（V3 成就）：全部条目网格，未达成可见条件，隐藏成就揭晓前打码 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="font-display text-fs-h2 text-gold">图鉴</h2>
            <span className="font-numeric text-fs-micro tabular-nums text-faint">
              {data.achievementSummary.owned}/{data.achievementSummary.total}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {data.achievements.map((a) => (
              <div
                key={a.key}
                className={`rounded-tile border px-3 py-2.5 ${
                  a.owned
                    ? "border-gold-line bg-gold-soft"
                    : "border-border bg-surface-2"
                }`}
              >
                <p
                  className={`font-display text-fs-sm ${
                    a.owned ? "text-gold" : "text-muted"
                  }`}
                >
                  {a.owned ? "✦ " : ""}
                  {a.name}
                </p>
                <p className="text-fs-micro mt-0.5 leading-relaxed text-faint">
                  {a.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 技能树（V3）：点亮进度 + 技能树入口 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="mb-2 font-display text-fs-h2 text-gold">技能树</h2>
          <p className="text-fs-meta text-muted">
            已点亮 {data.skillSummary.owned}/{data.skillSummary.total} 项——
            晨型人、连击铁律、签到酬勤……点亮后一直在结算里生效。
          </p>
          <div className="mt-3 flex justify-end border-t border-border pt-3">
            <Link
              href="/skills"
              className="rounded-btn border border-gold-line px-3 py-1.5 text-fs-sm text-gold transition-colors hover:bg-gold-soft"
            >
              查看技能树 →
            </Link>
          </div>
        </section>

        {/* 月账单（档案化）：本月汇总 + 类型筛选 + 分页 + 全量导出 */}
        <section className="rounded-card border border-border bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-fs-h2 text-gold">月账单</h2>
            <div className="flex items-center gap-3 text-fs-micro">
              <a
                href="/api/character/settlements?format=csv"
                className="text-muted transition-colors hover:text-fg"
                download
              >
                导出 CSV
              </a>
              <a
                href="/api/character/settlements?format=md"
                className="text-muted transition-colors hover:text-fg"
                download
              >
                导出 Markdown
              </a>
            </div>
          </div>
          <p className="font-numeric text-fs-micro tabular-nums text-muted">
            本月 +{data.monthSummary.xp} XP ·{" "}
            {data.monthSummary.gold >= 0
              ? `+${data.monthSummary.gold}`
              : data.monthSummary.gold}{" "}
            金币 · {data.monthSummary.count} 笔
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {BILL_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setBillKind(f.key)}
                className={`rounded-full border px-2.5 py-0.5 text-fs-micro transition-colors ${
                  billKind === f.key
                    ? "border-gold-line bg-gold-soft text-gold"
                    : "border-border text-muted hover:text-fg"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {bill === null && (
            <p className="mt-3 text-fs-meta text-muted">正在对账……</p>
          )}
          {bill !== null && bill.length === 0 && (
            <p className="mt-3 text-fs-meta text-muted">这个筛选下还没有记录。</p>
          )}
          {bill !== null && bill.length > 0 && (
            <div className="mt-2 space-y-2">
              {bill.map((s) => (
                <div
                  key={s.id}
                  className="border-b border-border pb-2 text-fs-meta last:border-0"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-fg">
                      {s.questTitle ?? KIND_LABEL[s.kind] ?? s.kind}
                    </span>
                    <span className="shrink-0 font-numeric tabular-nums text-faint">
                      {formatTime(s.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted">
                    <span className="font-numeric tabular-nums text-gold">
                      {s.xpAwarded >= 0 ? `+${s.xpAwarded} XP` : `${s.xpAwarded} XP`} /{" "}
                      {s.goldAwarded >= 0 ? `+${s.goldAwarded}` : s.goldAwarded} 金币
                    </span>
                    <span>{KIND_LABEL[s.kind] ?? s.kind}</span>
                    {Object.entries(s.attrSplit).map(([k, v]) => (
                      <span
                        key={k}
                        className={`font-numeric tabular-nums ${v < 0 ? "text-danger-text" : ""}`}
                      >
                        {ATTR_LABEL[k] ?? k} {v >= 0 ? `+${v}` : v}
                      </span>
                    ))}
                  </div>
                  {s.kind === "review_adjustment" &&
                    typeof (s.adjustments?.reason as unknown) === "string" && (
                      <p className="mt-1 text-fs-micro leading-relaxed text-gold">
                        复核理由：{s.adjustments?.reason as string}
                      </p>
                    )}
                  {s.kind === "purchase" &&
                    typeof (s.adjustments?.item_key as unknown) === "string" && (
                      <p className="mt-1 text-fs-micro text-muted">
                        购入：{itemDisplay(s.adjustments?.item_key as string)}
                      </p>
                    )}
                  {s.kind === "gift" &&
                    typeof (s.adjustments?.item_key as unknown) === "string" && (
                      <p className="mt-1 text-fs-micro text-muted">
                        送出：{itemDisplay(s.adjustments?.item_key as string)}
                        {s.adjustments?.stage_up ? "（交情更进一步）" : ""}
                      </p>
                    )}
                </div>
              ))}
              {billHasMore && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={loadMoreBill}
                    disabled={billLoading}
                    className="border-border text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-meta transition-colors disabled:opacity-50"
                  >
                    {billLoading ? "……" : "加载更早"}
                  </button>
                </div>
              )}
            </div>
          )}
          {error && (
            <p className="border-danger text-danger-text mt-2 rounded-tile border px-3 py-2 text-fs-meta">
              {error}
            </p>
          )}
        </section>
      </div>

      <BottomNav />
    </main>
  );
}
