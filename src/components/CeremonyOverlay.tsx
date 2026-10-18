"use client";

import { useEffect } from "react";
import { ATTR_LABEL } from "@/lib/labels";
import { playCue } from "@/lib/audio";

/**
 * 仪式覆盖层（V1.7 后端事件 → V2.0 前端落地，见 animation.css §2）。
 * - level_up：克制光柱卡片，不遮屏不阻塞，2.4s 自动消失
 * - rank_up：全屏蜡封重铸（旧位熔解 → 新位浇铸）+ 金箔扫光 + 金线涟漪，
 *   3s 自动消失，点击可提前关闭
 * 数值全部来自引擎结算（/api/chat 的 ceremony 事件），UI 不自行编造。
 */
export interface CeremonyEvent {
  type: "level_up" | "rank_up";
  scope?: string;
  from: string | number;
  to: string | number;
  gold?: number;
  /** 突破礼物品（rank_up 时由引擎写入） */
  items?: { name: string; count: number }[];
}

function scopeLabel(scope: string | undefined): string {
  if (!scope || scope === "total") return "总等级";
  return `${ATTR_LABEL[scope] ?? scope} 属性`;
}

export default function CeremonyOverlay({
  event,
  onDone,
}: {
  event: CeremonyEvent;
  onDone: () => void;
}) {
  const isRank = event.type === "rank_up";

  useEffect(() => {
    playCue(isRank ? "rank_up" : "level_up");
    const ms = isRank ? 3000 : 2400;
    const timer = window.setTimeout(onDone, ms);
    return () => window.clearTimeout(timer);
  }, [event, isRank, onDone]);

  if (!isRank) {
    return (
      <div className="ceremony-layer level_up" aria-live="polite">
        <div className="ceremony-level">
          <p className="ceremony-kicker">等级提升</p>
          <p className="ceremony-value font-numeric">
            Lv.{event.from} → Lv.{event.to}
          </p>
          <p className="ceremony-sub">{scopeLabel(event.scope)}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ceremony-layer rank_up"
      role="button"
      tabIndex={0}
      aria-label={`评级晋升 ${event.from} → ${event.to}`}
      onClick={onDone}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onDone();
      }}
    >
      <div className="ceremony-rank">
        <div className="ceremony-seal">
          <span className="seal from" aria-hidden>
            {event.from}
          </span>
          <span className="seal to">{event.to}</span>
          <span className="ripple" aria-hidden />
        </div>
        <p className="ceremony-kicker">突 破 达 成</p>
        <p className="ceremony-sub font-numeric">
          {event.from} → {event.to}
          {event.gold ? ` · 酬金 ${event.gold} 金币` : ""}
        </p>
        {event.items && event.items.length > 0 && (
          <p className="ceremony-sub">
            突破礼：{event.items.map((i) => `${i.name} ×${i.count}`).join("、")}
          </p>
        )}
        <p className="ceremony-hint">协会的蜡封已经重铸</p>
      </div>
      <div className="ceremony-sweep" aria-hidden />
    </div>
  );
}
