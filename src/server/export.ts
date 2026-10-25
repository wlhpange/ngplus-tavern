import type { SettlementRecord } from "./character";
import { ATTR_LABEL, KIND_LABEL, itemDisplay } from "../weblib/labels";

/**
 * 结算流水导出（面板「月账单 → 导出」）。
 * 纯函数层：CSV（带 BOM，Excel 直接打开不乱码）/ Markdown 表格。
 */

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function noteOf(r: SettlementRecord): string {
  const parts: string[] = [];
  const itemKey = typeof r.adjustments?.item_key === "string" ? r.adjustments.item_key : null;
  if (itemKey) parts.push(`物品：${itemDisplay(itemKey)}`);
  const reason = typeof r.adjustments?.reason === "string" ? r.adjustments.reason : null;
  if (reason) parts.push(`复核理由：${reason}`);
  if (r.adjustments?.stage_up) parts.push("交情更进一步");
  return parts.join("；");
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function settlementsToCsv(records: SettlementRecord[]): string {
  const header = ["时间", "类型", "委托", "XP", "金币", "属性", "备注"];
  const lines = [header.join(",")];
  for (const r of records) {
    const attrs = Object.entries(r.attrSplit)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${ATTR_LABEL[k] ?? k}${v > 0 ? "+" : ""}${v}`)
      .join(" ");
    lines.push(
      [
        stamp(r.createdAt),
        KIND_LABEL[r.kind] ?? r.kind,
        r.questTitle ?? "",
        r.xpAwarded,
        r.goldAwarded,
        attrs,
        noteOf(r),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

export function settlementsToMarkdown(records: SettlementRecord[]): string {
  const lines = [
    "# 二周目协会 · 结算流水",
    "",
    `导出时间：${stamp(Date.now())} · 共 ${records.length} 条`,
    "",
    "| 时间 | 类型 | 委托 | XP | 金币 | 属性 | 备注 |",
    "|---|---|---|---:|---:|---|---|",
  ];
  for (const r of records) {
    const attrs = Object.entries(r.attrSplit)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${ATTR_LABEL[k] ?? k}${v > 0 ? "+" : ""}${v}`)
      .join(" ");
    const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(
      `| ${stamp(r.createdAt)} | ${esc(KIND_LABEL[r.kind] ?? r.kind)} | ${esc(r.questTitle ?? "")} | ${
        r.xpAwarded >= 0 ? `+${r.xpAwarded}` : r.xpAwarded
      } | ${r.goldAwarded >= 0 ? `+${r.goldAwarded}` : r.goldAwarded} | ${esc(attrs)} | ${esc(noteOf(r))} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
