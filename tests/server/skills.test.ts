import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { character, items, memory, settlementLog, userSkills } from "../../src/server/db/schema";
import {
  computeModifiers,
  findSkill,
  getOwnedSkillKeys,
  getSkillModifiers,
  listSkills,
  purchaseSkill,
  skillCatalog,
} from "../../src/server/skills";
import { settleQuest } from "../../src/server/engine/settlement";
import { checkinReward } from "../../src/server/engine/checkin";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function setXpGold(totalXp: number, gold: number) {
  db.update(character).set({ totalXp, gold }).where(eq(character.userId, userId)).run();
}

describe("技能目录与修正值（纯函数）", () => {
  it("目录来自 economy_config，四类效果都能被识别", () => {
    const keys = skillCatalog().map((s) => s.key);
    expect(keys).toEqual(["early_bird", "checkin_boon", "iron_streak", "golden_touch"]);
    expect(findSkill("nope")).toBeNull();
  });

  it("computeModifiers：只累计已解锁技能，同类型相加", () => {
    expect(computeModifiers([])).toEqual({
      morningGoldRatio: 0,
      checkinBonusRatio: 0,
      streakCapAdd: 0,
      overCapAdd: 0,
    });
    const mods = computeModifiers(["early_bird", "iron_streak", "golden_touch"]);
    expect(mods.morningGoldRatio).toBeCloseTo(0.15);
    expect(mods.streakCapAdd).toBeCloseTo(0.15);
    expect(mods.overCapAdd).toBeCloseTo(0.25);
    expect(mods.checkinBonusRatio).toBe(0);
  });
});

describe("解锁（purchaseSkill）", () => {
  it("等级与金币都够：扣款、落技能、留痕（负金币）、记忆", () => {
    setXpGold(1200 /* Lv.5 */, 600);
    const r = purchaseSkill(db, userId, "iron_streak");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.goldLeft).toBe(100);

    expect(getOwnedSkillKeys(db, userId)).toEqual(["iron_streak"]);
    const log = db.select().from(settlementLog).where(eq(settlementLog.kind, "skill_purchase")).get()!;
    expect(log.goldAwarded).toBe(-500);
    expect(db.select().from(memory).all().some((m) => m.content.includes("连击铁律"))).toBe(true);

    // 对账不变式：600 + (-500) === character.gold
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(100);
  });

  it("等级不够：拒绝且不扣钱", () => {
    setXpGold(0 /* Lv.1 */, 1000);
    const r = purchaseSkill(db, userId, "golden_touch");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Lv.8");
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(1000);
  });

  it("金币不够：拒绝且不落技能", () => {
    setXpGold(1200, 10);
    const r = purchaseSkill(db, userId, "early_bird");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("金币不够");
    expect(db.select().from(userSkills).all()).toHaveLength(0);
  });

  it("重复解锁：拒绝", () => {
    setXpGold(1200, 1000);
    expect(purchaseSkill(db, userId, "early_bird").ok).toBe(true);
    const again = purchaseSkill(db, userId, "early_bird");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toContain("已经解锁");
    const c = db.select().from(character).where(eq(character.userId, userId)).get()!;
    expect(c.gold).toBe(700); // 只扣了一次
  });

  it("未知技能：拒绝", () => {
    setXpGold(1200, 1000);
    expect(purchaseSkill(db, userId, "phoenix_wings").ok).toBe(false);
  });
});

describe("技能效果在引擎里生效", () => {
  it("getSkillModifiers：从 DB 读已解锁技能", () => {
    setXpGold(1200, 1000);
    purchaseSkill(db, userId, "checkin_boon");
    expect(getSkillModifiers(db, userId).checkinBonusRatio).toBeCloseTo(0.5);
  });

  it("连击铁律：带 streakCapAdd 时连击上限 1.65", () => {
    const base = settleQuest({
      type: "daily", difficulty: 1, streak: 100, completionRatio: 1,
      primaryAttr: "mind", todaySettledXp: 0,
    });
    expect(base.multipliers.streak).toBe(1.5);
    const withSkill = settleQuest({
      type: "daily", difficulty: 1, streak: 100, completionRatio: 1,
      primaryAttr: "mind", todaySettledXp: 0, streakCapAdd: 0.15,
    });
    expect(withSkill.multipliers.streak).toBeCloseTo(1.65);
  });

  it("点金手：超额总乘区上限 1.5 → 1.75", () => {
    const withSkill = settleQuest({
      type: "once", difficulty: 1, streak: 100, completionRatio: 1.2,
      primaryAttr: "mind", todaySettledXp: 0, overCapAdd: 0.25,
    });
    expect(withSkill.multipliers.total).toBeCloseTo(1.75);
  });

  it("签到酬勤：签到奖励 ×1.5（XP/金币/分流同步放大）", () => {
    const plain = checkinReward({ primaryAttr: "mind" });
    const boosted = checkinReward({ primaryAttr: "mind" }, 0.5);
    expect(plain.xp).toBe(4);
    expect(boosted.xp).toBe(6);
    expect(boosted.gold).toBe(3);
    const sum = Object.values(boosted.attrSplit).reduce((a, b) => a + b, 0);
    expect(sum).toBe(boosted.xp);
  });
});

describe("listSkills（API 数据）", () => {
  it("返回金币/等级与每项 owned/levelOk/affordable", () => {
    setXpGold(1200 /* Lv.5 */, 450);
    const view = listSkills(db, userId);
    expect(view.gold).toBe(450);
    expect(view.totalLevel).toBe(5);
    const bird = view.skills.find((s) => s.key === "early_bird")!;
    expect(bird.levelOk).toBe(true);
    expect(bird.affordable).toBe(true);
    expect(bird.owned).toBe(false);

    const touch = view.skills.find((s) => s.key === "golden_touch")!;
    expect(touch.levelOk).toBe(false);

    const streak = view.skills.find((s) => s.key === "iron_streak")!;
    expect(streak.affordable).toBe(false); // 500 > 450
  });
});
