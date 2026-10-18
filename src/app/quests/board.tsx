"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ATTR_LABEL } from "@/lib/labels";
import { playCue } from "@/lib/audio";

interface Quest {
  id: string;
  checkin?: number;
  title: string;
  description: string | null;
  type: "daily" | "once" | "weekly" | "mainline" | "mainline_milestone";
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  attrReason: string | null;
  difficulty: number;
  status: string;
  streak: number;
  parentQuestId?: string | null;
  deadline: number | null;
  createdAt: number;
  completedAt: number | null;
}

interface MainlineQuest extends Quest {
  milestones: Quest[];
}

const TYPE_LABEL: Record<Quest["type"], string> = {
  daily: "日常",
  weekly: "每周",
  once: "一次性",
  mainline: "主线",
  mainline_milestone: "里程碑",
};

// 类型徽章（§7.3）：每日=青、一次性=冷星白、每周=秘法紫、主线=金（金淡底）
const TYPE_BADGE: Record<Quest["type"], string> = {
  daily: "border-accent-line text-accent",
  once: "border-border-strong text-fg",
  weekly: "border-[color-mix(in_oklch,var(--arcane-text)_40%,transparent)] text-arcane-text",
  mainline: "border-gold-line bg-gold-soft text-gold",
  mainline_milestone: "border-gold-line text-gold",
};

const GROUPS: { status: string; label: string; hint: string; dot: string }[] = [
  { status: "proposed", label: "待接受", hint: "会长的提议，去对话里确认", dot: "text-muted" },
  { status: "active", label: "进行中", hint: "", dot: "text-accent" },
  { status: "overdue", label: "已逾期", hint: "连击衰减中", dot: "text-danger-text" },
  { status: "completed", label: "已完成", hint: "", dot: "text-gold" },
];

/** 已完成列表默认展示条数（更早的折叠，避免告示板无限变长） */
const COMPLETED_PREVIEW = 8;

/** 难度三颗星位（§7.3）：满星实心金、半星渐变、空星线框 */
function DifficultyStars({ difficulty }: { difficulty: number }) {
  return (
    <span className="inline-flex items-center gap-px" aria-label={`难度 ${difficulty.toFixed(1)}`}>
      {[0, 1, 2].map((i) => {
        const filled = difficulty >= i + 1;
        const half = !filled && difficulty >= i + 0.5;
        return half ? (
          <span
            key={i}
            className="from-gold to-faint bg-gradient-to-r from-50% to-50% bg-clip-text text-transparent"
          >
            ★
          </span>
        ) : (
          <span key={i} className={filled ? "text-gold" : "text-faint opacity-60"}>
            ★
          </span>
        );
      })}
    </span>
  );
}

/** 完成蜡封（§7.3）：--danger 蜡体 + --gold 内线 + 「契」字，rotate(-8deg) */
function WaxSeal() {
  return (
    <span
      aria-hidden
      className="shadow-card absolute right-3 top-3 flex h-9 w-9 rotate-[-8deg] items-center justify-center rounded-full font-display text-sm text-gold"
      style={{
        background: "radial-gradient(circle at 30% 25%, var(--danger-soft), var(--danger) 65%)",
        boxShadow: "var(--inset-gold), var(--shadow-1)",
      }}
    >
      契
    </span>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 属性理由展示兜底：旧库里的兜底校正行带「[兜底修正]…原始理由：」技术前缀，
 * 服务端已不再写入；此处对存量行剥前缀，只给用户看原始理由。
 */
function displayReason(reason: string | null): string | null {
  if (!reason) return null;
  const marker = "原始理由：";
  const i = reason.indexOf(marker);
  if (i >= 0) return reason.slice(i + marker.length);
  if (reason.startsWith("[兜底修正]")) return "协会按任务类别校正过属性归属。";
  return reason;
}

function QuestCard({
  q,
  disputing,
  repeating,
  onDispute,
  onRepeat,
}: {
  q: Quest;
  disputing: string | null;
  repeating: string | null;
  onDispute: (q: Quest) => void;
  onRepeat: (q: Quest) => void;
}) {
  const done = q.status === "completed";
  return (
  <article
  className={`rounded-card border border-border bg-surface p-3.5 transition-colors duration-200 hover:border-border-strong hover:bg-surface-2 ${
  done ? "shadow-inset-gold" : ""
  }`}
  style={
  done
  ? undefined
  : {
  // §7.3 材质：内缩 6px 的极淡金线（gold 10%），完成时点亮为 --inset-gold
  boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--gold) 10%, transparent)",
  }
  }
  >
  {done && <WaxSeal />}
  <div className={`flex items-start justify-between gap-2 ${done ? "pr-10" : ""}`}>
  <h3 className="font-display text-fs-h2 leading-tight">{q.title}</h3>
  <span
  className={`shrink-0 rounded-full border px-2 py-0.5 font-numeric text-fs-micro uppercase tracking-widest ${q.checkin ? "border-gold-line bg-gold-soft text-gold" : TYPE_BADGE[q.type]}`}
  >
  {q.checkin ? "签到" : TYPE_LABEL[q.type]}
  </span>
  </div>
  {q.description && (
  <p className="mt-1 text-fs-meta text-muted">{q.description}</p>
  )}
  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-numeric text-fs-meta tabular-nums text-muted">
  <span className="text-fg">
  <span
  className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
  style={{ background: `var(--attr-${q.primaryAttr === "willpower" ? "will" : q.primaryAttr})` }}
  />
  {ATTR_LABEL[q.primaryAttr] ?? q.primaryAttr} ×{q.primaryWeight.toFixed(1)}
  </span>
  {q.secondaryAttr && (
  <span>
  ｜ {ATTR_LABEL[q.secondaryAttr] ?? q.secondaryAttr} ×
  {(q.secondaryWeight ?? 0).toFixed(1)}
  </span>
  )}
  <span className="inline-flex items-center gap-1">
  <DifficultyStars difficulty={q.difficulty} />
  <span>{q.difficulty.toFixed(1)}</span>
  </span>
  {q.type === "daily" && q.streak > 0 && (
  <span className={`inline-flex items-center gap-1 ${q.streak >= 7 ? "text-gold" : "text-flame"}`}>
  <i className="combo-flame" aria-hidden />
  连击 ×{q.streak}
  </span>
  )}
  {q.deadline && (
  <span className={`ml-auto ${q.status === "overdue" ? "text-danger-text" : ""}`}>
  截止 {formatDate(q.deadline)}
  </span>
  )}
  {done && q.completedAt && (
  <span className="ml-auto">完成于 {formatDate(q.completedAt)}</span>
  )}
  </div>
  {/* DESIGN-DECISION: 卡内不放 +XP/+金币报酬——奖励由结算引擎按公式在结算时算出，
  quest 表不存报酬，预写数值会违反「LLM/UI 无权声明数值」铁律。
  行动按钮只做「去对话」的入口导航，不改任何状态。 */}
  {(q.status === "proposed" || q.status === "active" || q.status === "overdue") && (
  <div className="mt-3 flex items-center justify-between gap-2">
  <Link
  href="/"
  className={`rounded-btn border px-3 py-1.5 text-fs-sm transition-colors ${
  q.status === "active"
  ? "border-gold-line text-gold hover:bg-gold-soft"
  : "border-accent-line text-accent hover:bg-accent-soft"
  }`}
  >
  {q.status === "proposed" && "去对话里接受 →"}
  {q.status === "active" && "去汇报战果 →"}
  {q.status === "overdue" && "去补上战果 →"}
  </Link>
  </div>
  )}
  {/* 已完成卡：可一键重挂（复制成新草稿）；属性映射与异议收进折叠区 */}
  {done && (
  <div className="mt-2 border-t border-border pt-2">
  <div className="flex items-center justify-between">
  <button
  type="button"
  disabled={repeating !== null}
  onClick={() => onRepeat(q)}
  className="border-accent-line text-accent hover:bg-accent-soft rounded-btn border px-2.5 py-1 text-fs-meta transition-colors disabled:opacity-40"
  >
  {repeating === q.id ? "重挂中……" : "再来一次"}
  </button>
  <span className="text-fs-micro text-faint">确认后直接进入「进行中」</span>
  </div>
  <details className="mt-1.5">
  <summary className="text-fs-micro text-faint cursor-pointer list-none">
  属性映射与异议
  </summary>
  {q.attrReason && (
  <p className="mt-1.5 text-fs-meta leading-relaxed text-faint">
  属性映射：{displayReason(q.attrReason)}
  </p>
  )}
  <div className="mt-1 flex justify-end">
  <button
  type="button"
  disabled={disputing !== null}
  onClick={() => onDispute(q)}
  className="rounded-btn text-muted hover:text-fg px-2 py-1 text-fs-meta transition-colors disabled:opacity-40"
  >
  {disputing === q.id ? "已递交会长……" : "对结算有异议？"}
  </button>
  </div>
  </details>
  </div>
  )}
  </article>
  );
}

const MILESTONE_DOT: Record<string, string> = {
  proposed: "text-muted",
  active: "text-accent",
  overdue: "text-danger-text",
  completed: "text-gold",
  abandoned: "text-faint",
  rejected: "text-faint",
};

/** 里程碑行：状态点 + 标题 + 难度 + 行动入口 */
function MilestoneRow({
  q,
  disputing,
  onDispute,
}: {
  q: Quest;
  disputing: string | null;
  onDispute: (q: Quest) => void;
}) {
  const action =
    q.status === "active" ? "去汇报 →" : q.status === "proposed" ? "待接受" : q.status === "overdue" ? "去补上 →" : null;
  return (
    <div className="flex items-center gap-2 border-t border-border py-2 first:border-t-0">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current ${MILESTONE_DOT[q.status] ?? "text-faint"}`}
      />
      <span className="min-w-0 flex-1 truncate text-fs-sm">{q.title}</span>
      <DifficultyStars difficulty={q.difficulty} />
      {q.status === "completed" && q.completedAt && (
        <span className="font-numeric text-fs-micro tabular-nums text-faint">
          {formatDate(q.completedAt)}
        </span>
      )}
      {action && (
        <Link href="/" className="text-accent text-fs-micro shrink-0">
          {action}
        </Link>
      )}
      {q.status === "completed" && (
        <button
          type="button"
          disabled={disputing !== null}
          onClick={() => onDispute(q)}
          className="text-faint hover:text-fg shrink-0 text-fs-micro transition-colors disabled:opacity-40"
        >
          异议
        </button>
      )}
    </div>
  );
}

/** 主线卡（§7.3 主线=金）：进度条 + 里程碑清单 */
function MainlineCard({
  m,
  disputing,
  onDispute,
}: {
  m: MainlineQuest;
  disputing: string | null;
  onDispute: (q: Quest) => void;
}) {
  const done = m.milestones.filter((x) => x.status === "completed").length;
  const total = m.milestones.length;
  const ratio = total > 0 ? done / total : 0;
  const completed = m.status === "completed";
  return (
    <article
      className="rounded-card border border-gold-line bg-surface shadow-inset-gold p-3.5"
      style={{
        boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--gold) 14%, transparent)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-display text-fs-h2 leading-tight">{m.title}</h3>
        <span className="border-gold-line bg-gold-soft text-gold shrink-0 rounded-full border px-2 py-0.5 font-numeric text-fs-micro uppercase tracking-widest">
          {completed ? "已达成" : "主线"}
        </span>
      </div>
      {m.description && <p className="mt-1 text-fs-meta text-muted">{m.description}</p>}

      <div className="mt-2.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--fg)_8%,transparent)]">
          <div
            className="bg-gold h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <span className="text-gold font-numeric text-fs-micro tabular-nums">
          {done}/{total} 里程碑
        </span>
      </div>

      {total > 0 && (
        <div className="mt-2">
          {m.milestones.map((q) => (
            <MilestoneRow key={q.id} q={q} disputing={disputing} onDispute={onDispute} />
          ))}
        </div>
      )}

      {m.status === "proposed" && (
        <div className="mt-3">
          <Link
            href="/"
            className="border-accent-line text-accent hover:bg-accent-soft rounded-btn inline-block border px-3 py-1.5 text-fs-sm transition-colors"
          >
            去对话里接受主线 →
          </Link>
        </div>
      )}
    </article>
  );
}

export default function QuestsPage() {
  const [quests, setQuests] = useState<Quest[] | null>(null);
  const [mainlines, setMainlines] = useState<MainlineQuest[]>([]);
  const [olderCompletedCount, setOlderCompletedCount] = useState(0);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [disputeError, setDisputeError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [repeating, setRepeating] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Quest | null>(null);
  const router = useRouter();

  const load = useCallback(() => {
    fetch("/api/quests")
      .then((r) => r.json())
      .then((d) => {
        setQuests(d.quests ?? []);
        setMainlines(d.mainlines ?? []);
        setOlderCompletedCount(d.olderCompletedCount ?? 0);
      })
      .catch(() => setQuests([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** V3：一键重挂（弹窗确认后直接挂成进行中） */
  async function handleRepeat(q: Quest) {
    if (repeating) return;
    setRepeating(q.id);
    setActionMsg(null);
    setDisputeError(null);
    try {
      const res = await fetch("/api/quests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repeat", questId: q.id }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        setDisputeError(data.error ?? "重挂没能办成，稍后再试。");
        return;
      }
      setConfirming(null);
      setActionMsg(`「${q.title}」重新挂上了，直接进行中。`);
      load();
    } catch {
      setDisputeError("重挂没能办成，稍后再试。");
    } finally {
      setRepeating(null);
    }
  }

  /** 代发一句话进对话（V1.5 异议双入口之一），会长当场复核 */
  async function handleDispute(q: Quest) {
    playCue("dispute");
    setDisputing(q.id);
    setDisputeError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `我对「${q.title}」的结算有异议：属性归属好像不对，你复核一下。`,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        setDisputeError(data.error ?? "异议没能递到会长手里，请稍后再试。");
        setDisputing(null);
        return;
      }
      router.push("/");
    } catch {
      setDisputeError("异议没能递到会长手里，请稍后再试。");
      setDisputing(null);
    }
  }

  return (
    <main className="bg-bg text-fg mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border flex items-center gap-3 border-b px-4 py-3">
        {/* 协会徽记（§7.1）：金描边圆形 + 罗盘星芒 */}
        <span
          aria-hidden
          className="border-gold-line text-gold flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
        >
          <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeLinecap="round" />
            <path d="M14.5 9.5 10 10l-2 4.5L12.5 14z" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-fs-h1 leading-tight">委托告示板</h1>
          <p className="font-numeric text-fs-micro tracking-wide text-muted">
            数据来自协会账本，与结算记录一致
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {quests === null && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            正在翻告示板……
          </p>
        )}

        {/* 统计条（2026-09-27 档案化）：让"越积越多"变成一眼可见的进度 */}
        {quests !== null && (
          <p className="font-numeric text-fs-micro tabular-nums text-faint">
            本月完成 {quests.filter((q) => q.status === "completed").length} 件 · 进行中{" "}
            {quests.filter((q) => q.status === "active").length} 件 · 待接受{" "}
            {quests.filter((q) => q.status === "proposed").length} 件
            {quests.some((q) => q.status === "overdue") &&
              ` · 逾期 ${quests.filter((q) => q.status === "overdue").length} 件`}
          </p>
        )}
        {actionMsg && (
          <p className="border-gold-line bg-gold-soft text-gold rounded-tile border px-3 py-2 text-fs-meta">
            {actionMsg}
          </p>
        )}

        {/* V2.0 主线：章节式推进（进度 + 里程碑清单） */}
        {mainlines.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-baseline gap-2">
              <span aria-hidden className="bg-gold inline-block h-1.5 w-1.5 self-center rounded-full" />
              <span className="font-display text-fs-h3 text-gold">主线</span>
              <span className="font-numeric text-fs-micro tabular-nums text-faint">
                {mainlines.filter((m) => m.status !== "completed").length} 条推进中
              </span>
            </h2>
            <div className="space-y-2.5">
              {mainlines.map((m) => (
                <MainlineCard key={m.id} m={m} disputing={disputing} onDispute={handleDispute} />
              ))}
            </div>
          </section>
        )}

        {quests !== null &&
          GROUPS.map((g) => {
            const all = quests.filter((q) => q.status === g.status);
            if (!all.length) return null;
            const capped = g.status === "completed" && !showAllCompleted;
            const list = capped ? all.slice(0, COMPLETED_PREVIEW) : all;
            return (
              <section key={g.status}>
                <h2 className="mb-2 flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 self-center rounded-full bg-current ${g.dot}`}
                  />
                  <span className={`font-display text-fs-h3 ${g.dot}`}>{g.label}</span>
                  <span className="font-numeric text-fs-micro tabular-nums text-faint">
                    {all.length} 件{g.hint && ` · ${g.hint}`}
                  </span>
                </h2>
                <div className="space-y-2.5">
                  {list.map((q) => (
                    <QuestCard
                      key={q.id}
                      q={q}
                      disputing={disputing}
                      repeating={repeating}
                      onDispute={handleDispute}
                      onRepeat={(quest) => setConfirming(quest)}
                    />
                  ))}
                </div>
                {capped && all.length > list.length && (
                  <button
                    type="button"
                    onClick={() => setShowAllCompleted(true)}
                    className="border-border text-muted hover:text-fg mt-2 w-full rounded-btn border px-3 py-2 text-fs-meta transition-colors"
                  >
                    显示全部 {all.length} 件已完成
                  </button>
                )}
                {/* 档案化：本月之前的完成记录不在告示板上堆积 */}
                {g.status === "completed" && olderCompletedCount > 0 && (
                  <Link
                    href="/quests/archive"
                    className="border-border text-muted hover:text-fg mt-2 flex w-full items-center justify-between rounded-btn border px-3 py-2 text-fs-meta transition-colors"
                  >
                    <span>更早的完成记录</span>
                    <span className="font-numeric tabular-nums">
                      {olderCompletedCount} 件 → 档案室
                    </span>
                  </Link>
                )}
              </section>
            );
          })}

        {quests !== null && quests.length === 0 && mainlines.length === 0 && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            告示板还空着。去和会长聊聊，挂第一件委托吧。
          </p>
        )}
        {disputeError && (
          <p className="border-danger bg-surface-2 rounded-tile border px-3 py-2 text-fs-meta text-danger-text">
            {disputeError}
          </p>
        )}
      </div>

      <BottomNav />

      {/* 再来一次：先确认，确认后直接挂成进行中 */}
      {confirming && (
        <ConfirmDialog
          title={`再来一次「${confirming.title}」？`}
          description="按同样的属性与难度重挂一件，确认后直接进入「进行中」，不用再去对话里接受。"
          confirmLabel="挂上"
          busy={repeating === confirming.id}
          onConfirm={() => handleRepeat(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </main>
  );
}
