import { config, type AttrKey } from "./config";

/**
 * V1.8 签到结算：
 * 到场奖励，**平基准、不吃连击/难度/超额**——奖励存在感让位给连击本身。
 * 属性分流沿用任务自身的权重映射（喂给正确的属性格）。
 */

export interface CheckinSplitInput {
  primaryAttr: AttrKey;
  primaryWeight?: number;
  secondaryAttr?: AttrKey | null;
  secondaryWeight?: number | null;
}

export interface CheckinReward {
  xp: number;
  gold: number;
  /** 属性分流（整数，合计 === xp） */
  attrSplit: Partial<Record<AttrKey, number>>;
}

export function checkinReward(
  input: CheckinSplitInput,
  bonusRatio = 0,
): CheckinReward {
  const xp = Math.round(config.checkin_base.xp * (1 + bonusRatio));
  const gold = Math.round(config.checkin_base.gold * (1 + bonusRatio));

  const pw = input.primaryWeight ?? 1.0;
  const hasSec = input.secondaryAttr != null && (input.secondaryWeight ?? 0) > 0;
  const sw = hasSec ? (input.secondaryWeight as number) : 0;
  const sum = hasSec ? pw + sw : 1;

  const attrSplit: Partial<Record<AttrKey, number>> = {};
  const primary = Math.round((xp * pw) / sum);
  attrSplit[input.primaryAttr] = primary;
  if (hasSec && input.secondaryAttr) {
  // 取整误差并入辅属性前先给辅属性补齐：合计必须 === xp
  attrSplit[input.secondaryAttr] = xp - primary;
  }
  return { xp, gold, attrSplit };
}
