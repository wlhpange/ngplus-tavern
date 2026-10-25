import configJson from "../../config/economy_config.json";

// 经济常数唯一来源：economy_config.json"（ 配置驱动原则）
export const config = configJson;

export type QuestType = keyof typeof config.quest_base;
export type AttrKey =
  | "vitality"
  | "mind"
  | "willpower"
  | "wealth"
  | "social"
  | "creativity";

export const ATTR_KEYS: AttrKey[] = [
  "vitality",
  "mind",
  "willpower",
  "wealth",
  "social",
  "creativity",
];
