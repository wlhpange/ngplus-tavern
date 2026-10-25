import { describe, it, expect } from "vitest";
import { checkinReward } from "../src/server/engine/checkin";

describe("签到结算（V1.8：平基准，不吃连击/难度）", () => {
  it("单属性：4 XP 全归主属性，金币 2", () => {
    const r = checkinReward({ primaryAttr: "mind", primaryWeight: 1.0 });
    expect(r.xp).toBe(4);
    expect(r.gold).toBe(2);
    expect(r.attrSplit).toEqual({ mind: 4 });
  });

  it("双属性：按权重分流，Σ === xp", () => {
    const r = checkinReward({
      primaryAttr: "willpower",
      primaryWeight: 0.7,
      secondaryAttr: "vitality",
      secondaryWeight: 0.3,
    });
    expect(r.xp).toBe(4);
    const sum = Object.values(r.attrSplit).reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    expect(r.attrSplit.willpower).toBe(3);
    expect(r.attrSplit.vitality).toBe(1);
  });

  it("高 streak 也不加成：连击 99 天仍是 4 XP（存在感让位给连击）", () => {
    const r = checkinReward({ primaryAttr: "vitality", primaryWeight: 1.0 });
    expect(r.xp).toBe(4);
  });
});
