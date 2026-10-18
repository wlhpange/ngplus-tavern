import { describe, it, expect } from "vitest";
import { settlementsToCsv, settlementsToMarkdown } from "../../src/server/export";
import type { SettlementRecord } from "../../src/server/character";

const base: SettlementRecord = {
  id: "s1",
  kind: "quest_complete",
  questTitle: "周末徒步 15 公里, 含休息",
  completionRatio: 1,
  confidence: 0.9,
  xpAwarded: 90,
  goldAwarded: 30,
  attrSplit: { vitality: 72, willpower: 18 },
  adjustments: null,
  createdAt: new Date(2026, 8, 27, 10, 30).getTime(),
};

describe("结算流水导出", () => {
  it("CSV：带 BOM、表头、含逗号的委托名被引号包裹", () => {
    const csv = settlementsToCsv([base]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("时间,类型,委托,XP,金币,属性,备注");
    expect(csv).toContain('"周末徒步 15 公里, 含休息"');
    expect(csv).toContain("2026-09-27 10:30");
    expect(csv).toContain("委托完成");
    expect(csv).toContain("体魄+72 意志+18");
  });

  it("CSV/Markdown：备注包含复核理由 / 物品 / 交情", () => {
    const records: SettlementRecord[] = [
      { ...base, id: "s2", kind: "review_adjustment", xpAwarded: 9, goldAwarded: 0,
        adjustments: { reason: "计划外的巧思" } },
      { ...base, id: "s3", kind: "gift", xpAwarded: 0, goldAwarded: 0,
        adjustments: { item_key: "gift_tea", stage_up: true } },
    ];
    const csv = settlementsToCsv(records);
    expect(csv).toContain("复核理由：计划外的巧思");
    expect(csv).toContain("物品：一盏热茶");
    expect(csv).toContain("交情更进一步");

    const md = settlementsToMarkdown(records);
    expect(md).toContain("| 时间 | 类型 | 委托 | XP | 金币 | 属性 | 备注 |");
    expect(md).toContain("礼物赠送");
    expect(md).toContain("复核理由：计划外的巧思");
    expect(md).toContain("共 2 条");
  });

  it("Markdown：竖线被转义，不破坏表格", () => {
    const md = settlementsToMarkdown([
      { ...base, questTitle: "读《A|B》并写笔记" },
    ]);
    expect(md).toContain("读《A\\|B》并写笔记");
  });
});
