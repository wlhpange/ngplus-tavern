"use client";

import { useEffect, useState } from "react";
import { ATTR_LABEL, KIND_LABEL, itemDisplay } from "@/lib/labels";
import { playCue } from "@/lib/audio";

export interface SettlementCardData {
  id: string;
  kind: string;
  questTitle: string | null;
  completionRatio: number | null;
  confidence: number | null;
  xpAwarded: number;
  goldAwarded: number;
  attrSplit: Record<string, number>;
  adjustments: Record<string, unknown> | null;
  createdAt: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 对话时间线里的结算卡片（V2.0）。
 * 数据全部来自 settlement_log；数值由引擎写入，前端只负责展示。
 * fresh=true 时播放结算仪式三连（蜡封下压 / 金箔扫光 / 金币雨，见 animation.css §3）：
 * - 部分结算（completionRatio<1）：蜡封暗铜色、金币雨减半
 * - 逾期补结算（adjustments.was_overdue）：蜡封带裂纹，随后自愈
 */
export default function SettlementCard({
  s,
  fresh = false,
  silent = false,
}: {
  s: SettlementCardData;
  fresh?: boolean;
  /** 同一轮有更隆重的仪式（升级/晋段）时静音，避免音效叠放 */
  silent?: boolean;
}) {
  // 本轮新卡：按事件类型播一声（历史卡片重放不发声）
  useEffect(() => {
    if (!fresh || silent) return;
    if (s.kind === "quest_complete" || s.kind === "mainline_complete") {
      playCue(s.completionRatio != null && s.completionRatio < 1 ? "settle_partial" : "settle");
    } else if (s.kind === "purchase") {
      playCue("purchase");
    } else if (s.kind === "gift") {
      playCue("gift");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kindLabel = KIND_LABEL[s.kind] ?? s.kind;
  const title = s.questTitle ?? kindLabel;
  const isGain = s.kind === "quest_complete" || s.kind === "mainline_complete" || s.kind === "bonus";
  const partial = s.completionRatio != null && s.completionRatio < 1;
  const overdue = s.adjustments?.was_overdue === true;
  const rarity =
    s.adjustments?.rarity === "legendary"
      ? "传说"
      : s.adjustments?.rarity === "rare"
        ? "稀有"
        : null;
  const itemKey = typeof s.adjustments?.item_key === "string" ? s.adjustments.item_key : null;
  const reason = typeof s.adjustments?.reason === "string" ? s.adjustments.reason : null;
  const attrs = Object.entries(s.attrSplit).filter(([, v]) => v !== 0);
  const hasDetails = attrs.length > 0 || Boolean(rarity) || Boolean(itemKey) || Boolean(reason);
  // 长列表优化：历史卡片默认收起详情（只留一行），本轮新卡片展开并播动画
  const [open, setOpen] = useState(fresh || !hasDetails);

  return (
    <article
      className={`settlement-card ${fresh ? "is-fresh" : ""}`}
      data-kind={s.kind}
      data-partial={partial ? "1" : undefined}
      data-overdue={overdue ? "1" : undefined}
    >
      <div className="settlement-sweep" aria-hidden />
      <div className="settlement-coins" aria-hidden>
        {Array.from({ length: 10 }).map((_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="relative flex items-start gap-3">
        <span className="settlement-seal" aria-hidden>
          契
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-fs-h3 leading-snug">{title}</p>
          <p className="font-numeric text-fs-micro tabular-nums text-muted">
            {kindLabel} · {formatTime(s.createdAt)}
          </p>
        </div>
        <div className="shrink-0 text-right font-numeric text-fs-sm tabular-nums">
          {s.xpAwarded !== 0 && (
            <p className="text-accent">{s.xpAwarded > 0 ? `+${s.xpAwarded}` : s.xpAwarded} XP</p>
          )}
          {s.goldAwarded !== 0 && (
            <p className={s.goldAwarded > 0 ? "text-gold" : "text-muted"}>
              {s.goldAwarded > 0 ? `+${s.goldAwarded}` : s.goldAwarded} 金币
            </p>
          )}
        </div>
      </div>

      {hasDetails && open && (
        <div className="relative mt-2 border-t border-border pt-2 text-fs-micro text-muted">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {attrs.map(([k, v]) => (
              <span key={k} className="font-numeric tabular-nums">
                {ATTR_LABEL[k] ?? k} {v > 0 ? `+${v}` : v}
              </span>
            ))}
            {rarity && (
              <span className="rounded-chip border border-gold-line bg-gold-soft px-1.5 py-0.5 font-numeric text-gold">
                {rarity}
              </span>
            )}
            {itemKey && (
              <span>
                {s.kind === "purchase" ? "购入" : "送出"}：{itemDisplay(itemKey)}
              </span>
            )}
          </div>
          {reason && isGain && (
            <p className="mt-1 leading-relaxed text-gold">复核理由：{reason}</p>
          )}
        </div>
      )}

      {hasDetails && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative mt-1 block w-full text-right text-fs-micro text-faint transition-colors hover:text-fg"
        >
          {open ? "收起 ▴" : "详情 ▾"}
        </button>
      )}
    </article>
  );
}
