import { ATTR_KEYS } from "../engine/config";
import { config } from "../engine/config";

/**
 * OpenAI function calling 形态的工具定义。
 *
 * 从 tools.ts 抽出：这里只是给模型看的 schema（长、纯数据），
 * 与执行逻辑分开后，改工具描述不必在 1000 行的执行文件里翻找。
 */

/** OpenAI function calling 形态的工具定义（TOOL_DEFINITIONS 的数据格式，AI SDK 侧由 buildToolSet 转换） */
export interface ToolDefinition {
  type: "function";
  function: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  };
}

export const ATTR_ENUM = ATTR_KEYS;
export const QUEST_TYPE_ENUM = ["daily", "once", "weekly", "mainline", "mainline_milestone"];
export const CATEGORY_ENUM = Object.keys(config.attr_whitelist);

/** 动态生成白名单速查文本（注入 create_quest 描述，降低属性越界打回率） */
const WHITELIST_HINT = Object.entries(config.attr_whitelist)
  .map(([cat, attrs]) => `${cat}→${attrs.join("/")}`)
  .join("；");

/**
 * 六个工具的 JSON Schema。
 * DESIGN-DECISION: create_quest 增加 category（§8 要求 LLM 先给任务类别，
 * 服务端对照白名单校验属性）与 parent_quest_id（mainline_milestone 必须挂主线）两个参数。
 * V0.5: description 动态注入白名单速查，LLM 第一次就能判对属性，减少打回重判浪费。
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
  type: "function",
  function: {
  name: "create_quest",
  description:
  `从对话中提取用户意图，创建任务草稿（status=proposed，待用户确认）。必须先判断任务类别 category，再按类别允许的属性分配 primary/secondary_attr。白名单速查：${WHITELIST_HINT}。`,
  parameters: {
  type: "object",
  properties: {
  title: { type: "string" },
  description: { type: "string" },
  type: {
  type: "string",
  enum: QUEST_TYPE_ENUM,
  description:
  "任务类型：daily/once/weekly 常规；mainline=主线大目标（不挂父任务）；mainline_milestone=主线里程碑（必须提供 parent_quest_id，且在主线被用户接受前一次拆完）",
  },
  category: {
  type: "string",
  enum: CATEGORY_ENUM,
  description: "任务类别，决定允许分配的属性白名单",
  },
  primary_attr: { type: "string", enum: ATTR_ENUM },
  primary_weight: { type: "number", minimum: 0.6, maximum: 1.0 },
  secondary_attr: { type: "string", enum: ATTR_ENUM },
  secondary_weight: { type: "number", minimum: 0.2, maximum: 0.4 },
  attr_reason: { type: "string", description: "为什么这样分配属性" },
  difficulty: { type: "number", minimum: 0.5, maximum: 3.0 },
  deadline: { type: "string", format: "date" },
  parent_quest_id: {
  type: "string",
  description: "mainline_milestone 必填，挂到主线任务",
  },
  checkin: {
  type: "boolean",
  description:
  "签到委托：每天第一次对话自动完成，无需汇报（仅 daily 可用）。当用户提到低摩擦的到场型习惯（如打卡、报到）时，主动建议此项。",
  },
  },
  required: ["title", "type", "category", "primary_attr", "attr_reason"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "respond_to_quest",
  description: "用户接受/拒绝提议中的任务",
  parameters: {
  type: "object",
  properties: {
  quest_id: { type: "string" },
  action: { type: "string", enum: ["accept", "reject"] },
  },
  required: ["quest_id", "action"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "lookup_quests",
  description: "查询任务列表（AI 不靠自己记忆任务，必须调用此工具）",
  parameters: {
  type: "object",
  properties: {
  status: {
  type: "string",
  enum: ["proposed", "active", "overdue", "all"],
  },
  },
  required: ["status"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "settle_completion",
  description:
  "用户汇报完成某任务时调用。引擎校验并计算实际奖励，返回结算结果",
  parameters: {
  type: "object",
  properties: {
  quest_id: { type: "string" },
  evidence: { type: "string", description: "用户汇报中的关键证据" },
  completion_ratio: { type: "number", minimum: 0, maximum: 1.2 },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["quest_id", "completion_ratio", "confidence"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "query_character",
  description: "查询角色面板（等级/属性/金币/称号）",
  parameters: { type: "object", properties: {} },
  },
  },
  {
  type: "function",
  function: {
  name: "add_memory",
  description: "记录值得长期记住的用户信息",
  parameters: {
  type: "object",
  properties: {
  category: {
  type: "string",
  enum: ["profile", "preference", "event", "goal", "story", "relationship"],
  },
  content: { type: "string" },
  },
  required: ["category", "content"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "buy_item",
  description:
  "用户要在协会商店买东西、囤休整卷轴，或想给你买礼物时调用。价格与金币由服务端校验；买下的礼物只是放进抽屉，等 ta 送给你（送礼调用 gift_item），你接一句人话即可。",
  parameters: {
  type: "object",
  properties: {
  item_key: {
  type: "string",
  description:
  "商品 key，如 rest_scroll / gift_tea / gift_book / gift_sweet / gift_pocket_watch",
  },
  },
  required: ["item_key"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "gift_item",
  description:
  "用户要把一件已买下的礼物送给你时调用（休整卷轴不是礼物）。服务端校验抽屉里的持有数量并消耗一份、推进你们的交情；抽屉里没有存货时不要调用本工具，改用 buy_item 提议先买一份。",
  parameters: {
  type: "object",
  properties: {
  item_key: {
  type: "string",
  description:
  "礼物 key：gift_tea / gift_book / gift_sweet / gift_pocket_watch",
  },
  },
  required: ["item_key"],
  },
  },
  },
  {
  type: "function",
  function: {
  name: "file_dispute",
  description:
  "用户对某笔结算不服（属性归属/判定不公/漏算收获）时调用。服务端自动定位该委托最近一次结算并当场触发复核管线，复核结论稍后以系统复核消息回给你。",
  parameters: {
  type: "object",
  properties: {
  quest_id: { type: "string" },
  claim: {
  type: "string",
  description: "用户的异议主张，保留原话要点",
  },
  },
  required: ["quest_id", "claim"],
  },
  },
  },
];

