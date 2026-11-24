/**
 * 对话时间线的纯函数（排序 / 去重 / 日期分组）。
 * 与 React 无关，便于单测与在子组件间复用。
 */

import type { ApiMessage, TimelineItem } from "./types";

/** 同一毫秒内的排序权重：用户发言 → 结算卡片 → 会长回复 */
export function itemRank(it: TimelineItem): number {
  if (it.type === "settlement") return 1;
  return it.message.role === "user" ? 0 : 2;
}

export function itemTime(it: TimelineItem): number {
  return it.type === "message" ? it.message.createdAt : it.settlement.createdAt;
}

export function itemKey(it: TimelineItem): string {
  return it.type === "message" ? it.message.id : `s_${it.settlement.id}`;
}

/** 合并两段时间线：按时间升序、同刻按角色定序、按 id 去重（翻页重叠安全） */
export function mergeItems(base: TimelineItem[], add: TimelineItem[]): TimelineItem[] {
  const seen = new Map<string, TimelineItem>();
  for (const it of [...base, ...add]) {
    if (!seen.has(itemKey(it))) seen.set(itemKey(it), it);
  }
  return [...seen.values()].sort(
    (a, b) => itemTime(a) - itemTime(b) || itemRank(a) - itemRank(b),
  );
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(now.getTime())) return "今天";
  if (dayKey(ts) === dayKey(yesterday.getTime())) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function messageOf(it: TimelineItem): ApiMessage | null {
  return it.type === "message" ? it.message : null;
}
