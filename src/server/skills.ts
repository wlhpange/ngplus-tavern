import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { character, memory, settlementLog, userSkills } from "./db/schema";
import { config } from "./engine/config";
import { levelFromXp } from "./engine/leveling";

/**
 * 技能树（V3）：
 * - 技能目录在 economy_config.skills（配置驱动，改数值不动代码）
 * - 解锁条件 = 金币 + 总等级；解锁后效果由引擎在结算/签到处读取生效
 * - 对账不变式：解锁写 settlement_log（kind="skill_purchase"，gold_awarded=负价），
 *   面板金币恒等于 settlement_log 累计
 */

export interface SkillDef {
  key: string;
  name: string;
  desc: string;
  cost_gold: number;
  min_level: number;
  effect: { type: string; value: number };
}

export function skillCatalog(): SkillDef[] {
  return config.skills as SkillDef[];
}

export function findSkill(key: string): SkillDef | null {
  return skillCatalog().find((s) => s.key === key) ?? null;
}

/** 已解锁技能集中后的结算修正值 */
export interface SkillModifiers {
  /** 早上（05:00–11:00）结算金币加成比例 */
  morningGoldRatio: number;
  /** 签到奖励加成比例 */
  checkinBonusRatio: number;
  /** 连击加成上限增量 */
  streakCapAdd: number;
  /** 超额总乘区上限增量 */
  overCapAdd: number;
}

/** 纯函数：由已解锁 key 集合计算修正值（同类型效果直接相加） */
export function computeModifiers(ownedKeys: Iterable<string>): SkillModifiers {
  const keys = new Set(ownedKeys);
  const mods: SkillModifiers = {
    morningGoldRatio: 0,
    checkinBonusRatio: 0,
    streakCapAdd: 0,
    overCapAdd: 0,
  };
  for (const skill of skillCatalog()) {
    if (!keys.has(skill.key)) continue;
    switch (skill.effect.type) {
      case "morning_gold_ratio":
        mods.morningGoldRatio += skill.effect.value;
        break;
      case "checkin_bonus_ratio":
        mods.checkinBonusRatio += skill.effect.value;
        break;
      case "streak_bonus_cap_add":
        mods.streakCapAdd += skill.effect.value;
        break;
      case "over_bonus_cap_add":
        mods.overCapAdd += skill.effect.value;
        break;
    }
  }
  return mods;
}

export function getOwnedSkillKeys(db: Db, userId: string): string[] {
  return db
    .select({ skillKey: userSkills.skillKey })
    .from(userSkills)
    .where(eq(userSkills.userId, userId))
    .all()
    .map((r) => r.skillKey);
}

export function getSkillModifiers(db: Db, userId: string): SkillModifiers {
  return computeModifiers(getOwnedSkillKeys(db, userId));
}

export interface SkillView extends SkillDef {
  owned: boolean;
  levelOk: boolean;
  affordable: boolean;
}

export function listSkills(
  db: Db,
  userId: string,
): { gold: number; totalLevel: number; skills: SkillView[] } {
  const char = db.select().from(character).where(eq(character.userId, userId)).get();
  const gold = char?.gold ?? 0;
  const totalLevel = char ? levelFromXp(char.totalXp) : 1;
  const owned = new Set(getOwnedSkillKeys(db, userId));
  return {
    gold,
    totalLevel,
    skills: skillCatalog().map((s) => ({
      ...s,
      owned: owned.has(s.key),
      levelOk: totalLevel >= s.min_level,
      affordable: gold >= s.cost_gold,
    })),
  };
}

export type PurchaseSkillResult =
  | { ok: true; skill: SkillDef; goldLeft: number }
  | { ok: false; error: string };

export function purchaseSkill(
  db: Db,
  userId: string,
  skillKey: string,
  now = Date.now(),
): PurchaseSkillResult {
  const skill = findSkill(skillKey);
  if (!skill) return { ok: false, error: `技能树里没有「${skillKey}」` };

  const char = db.select().from(character).where(eq(character.userId, userId)).get();
  if (!char) return { ok: false, error: "角色数据缺失，请先完成初始化" };
  const totalLevel = levelFromXp(char.totalXp);

  const owned = db
    .select({ id: userSkills.id })
    .from(userSkills)
    .where(and(eq(userSkills.userId, userId), eq(userSkills.skillKey, skillKey)))
    .get();
  if (owned) return { ok: false, error: `「${skill.name}」已经解锁过了` };
  if (totalLevel < skill.min_level) {
    return {
      ok: false,
      error: `等级不够：解锁「${skill.name}」需要 Lv.${skill.min_level}，你现在 Lv.${totalLevel}。`,
    };
  }
  if (char.gold < skill.cost_gold) {
    return {
      ok: false,
      error: `金币不够：解锁「${skill.name}」要 ${skill.cost_gold} 金币，你还差 ${skill.cost_gold - char.gold}。`,
    };
  }

  const goldLeft = char.gold - skill.cost_gold;
  db.update(character).set({ gold: goldLeft }).where(eq(character.userId, userId)).run();
  db.insert(userSkills)
    .values({ id: randomUUID(), userId, skillKey, unlockedAt: now })
    .run();
  // 留痕（负金币保持对账闭合）
  db.insert(settlementLog)
    .values({
      id: randomUUID(),
      userId,
      questId: null,
      kind: "skill_purchase",
      completionRatio: null,
      confidence: null,
      xpAwarded: 0,
      goldAwarded: -skill.cost_gold,
      attrSplitJson: "{}",
      adjustmentsJson: JSON.stringify({ skill_key: skill.key, effect: skill.effect }),
      llmReasoning: null,
      createdAt: now,
    })
    .run();
  // 记忆：会长知道冒险者点亮了什么
  db.insert(memory)
    .values({
      id: randomUUID(),
      userId,
      category: "event",
      content: `点亮技能「${skill.name}」`,
      createdAt: now,
    })
    .run();

  return { ok: true, skill, goldLeft };
}
