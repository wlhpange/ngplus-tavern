import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import {
  quests,
  character,
  disputes,
  settlementLog,
  memory,
  saves,
  users,
  items,
} from "../db/schema";
import { config, ATTR_KEYS, type AttrKey } from "../engine/config";
import { settleQuest } from "../engine/settlement";
import { applyOnceBonus } from "../engine/rarity";
import { reviveQuestAfterSettlement } from "../cron/jobs";
import {
  levelFromXp,
} from "../engine/leveling";
import { getCharacterSummary } from "../character";
import { applyRankPromotion } from "../rankPromotion";
import { getSkillModifiers } from "../skills";
import {
  dailyFirstSettlementXpRatio,
  dailyGoldRatio,
} from "../dailyEvent";
import { giftItem, purchaseItem, shopCatalog } from "../shop";
import { addMemory, isMemoryCategory } from "../memory";
import { getTodaySettledXp } from "../character";
import { startOfToday } from "../util/time";
/** OpenAI function calling 形态的工具定义（TOOL_DEFINITIONS 的数据格式，AI SDK 侧由 buildToolSet 转换） */
export interface ToolDefinition {
  type: "function";
  function: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  };
}

const ATTR_ENUM = ATTR_KEYS;
const QUEST_TYPE_ENUM = ["daily", "once", "weekly", "mainline", "mainline_milestone"];
const CATEGORY_ENUM = Object.keys(config.attr_whitelist);

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

/** 每轮对话的工具执行上下文（越界打回计数 + 可注入随机源） */
export interface ToolContext {
  attrRejections: number;
  /** V1.8 稀有度掷骰随机源；默认 Math.random()，测试注入固定序列 */
  rand: () => number;
}

export function createToolContext(rand: () => number = Math.random): ToolContext {
  return { attrRejections: 0, rand };
}

export interface ToolExecResult {
  ok: boolean;
  /** 回注给 LLM 的结构化结果 */
  data: unknown;
  /** 一句话摘要（写入 chat_log system 记录 + 返回前端刷新面板） */
  summary: string;
  /** 本轮是否产生了游戏状态变更（前端据此刷新面板） */
  stateChanged: boolean;
}

function err(message: string, data?: Record<string, unknown>): ToolExecResult {
  return { ok: false, data: { error: message, ...data }, summary: message, stateChanged: false };
}

type Args = Record<string, unknown>;

function asAttr(v: unknown): AttrKey | null {
  return typeof v === "string" && (ATTR_ENUM as string[]).includes(v)
  ? (v as AttrKey)
  : null;
}

// ---------- create_quest ----------

function execCreateQuest(
  db: Db,
  userId: string,
  args: Args,
  ctx: ToolContext,
): ToolExecResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const type = args.type as string;
  const category = args.category as string;
  if (!title) return err("缺少任务标题 title");
  if (!QUEST_TYPE_ENUM.includes(type)) return err(`非法任务类型：${type}`);

  const whitelist = config.attr_whitelist as Record<string, AttrKey[]>;
  const allowed = whitelist[category];
  if (!allowed) {
  return err(`未知任务类别：${category}，可选类别：${CATEGORY_ENUM.join("/")}`);
  }

  const primaryAttr = asAttr(args.primary_attr);
  if (!primaryAttr) return err("缺少或非法的 primary_attr");
  const secondaryAttr = args.secondary_attr != null ? asAttr(args.secondary_attr) : null;
  if (args.secondary_attr != null && !secondaryAttr) {
  return err("非法的 secondary_attr");
  }

  // §8 属性白名单校验：越界打回重判一次，仍越界则兜底取类别第一个允许属性
  let attrReason = typeof args.attr_reason === "string" ? args.attr_reason : "";
  let finalPrimary = primaryAttr;
  let finalSecondary = secondaryAttr;
  const primaryViolation = !allowed.includes(primaryAttr);
  const secondaryViolation = secondaryAttr != null && !allowed.includes(secondaryAttr);
  if (primaryViolation || secondaryViolation) {
  if (ctx.attrRejections === 0) {
  ctx.attrRejections += 1;
  return err(
  `属性分配越界：类别「${category}」只允许属性 ${allowed.join("/")}，` +
  `你给出的是 ${primaryAttr}${secondaryAttr ? `/${secondaryAttr}` : ""}。请重新判定后再调用一次 create_quest。`,
  { retry: true, allowed_attrs: allowed },
  );
  }
  // 第二次仍越界：兜底取类别第一个允许属性。
  // DESIGN-DECISION: 校正只记服务端日志（对账可见），attr_reason 保留 LLM 的
  // 原始理由——技术话术不进用户界面（旧库中的 [兜底修正] 前缀由展示层兜底剥离）。
  finalPrimary = allowed[0];
  finalSecondary = null;
  console.log(
  `[attr-fallback] 类别「${category}」越界修正：${primaryAttr}${secondaryAttr ? `/${secondaryAttr}` : ""} → ${allowed[0]}`,
  );
  }

  // 权重范围校验
  const [pwMin, pwMax] = config.attr_split.primary_weight_range;
  const [swMin, swMax] = config.attr_split.secondary_weight_range;
  const primaryWeight =
  typeof args.primary_weight === "number" ? args.primary_weight : 1.0;
  if (primaryWeight < pwMin || primaryWeight > pwMax) {
  return err(`primary_weight 须在 ${pwMin}~${pwMax} 之间`);
  }
  let secondaryWeight: number | null = null;
  if (finalSecondary) {
  secondaryWeight =
  typeof args.secondary_weight === "number" ? args.secondary_weight : 0.3;
  if (secondaryWeight < swMin || secondaryWeight > swMax) {
  return err(`secondary_weight 须在 ${swMin}~${swMax} 之间`);
  }
  }

  const difficulty =
  typeof args.difficulty === "number"
  ? args.difficulty
  : config.difficulty.default;
  if (difficulty < config.difficulty.min || difficulty > config.difficulty.max) {
  return err(
  `difficulty 须在 ${config.difficulty.min}~${config.difficulty.max} 之间`,
  );
  }

  // V1.8 签到标志：仅 daily 可用
  const checkin = args.checkin === true;
  if (checkin && type !== "daily") {
  return err("签到委托只能是每日类型（daily）");
  }

  // V2.0 主线拆解：
  // - mainline 不挂父任务（它就是父任务）
  // - mainline_milestone 必须挂到 type=mainline 且尚未接受（proposed）的主线；
  //   拆解期一次拆完，主线被接受后里程碑不可再追加（总数固定）
  let parentQuestId: string | null = null;
  if (type === "mainline_milestone") {
  parentQuestId =
  typeof args.parent_quest_id === "string" ? args.parent_quest_id : null;
  if (!parentQuestId) {
  return err("mainline_milestone 必须提供 parent_quest_id（挂到主线任务）");
  }
  const parent = db
  .select()
  .from(quests)
  .where(and(eq(quests.id, parentQuestId), eq(quests.userId, userId)))
  .get();
  if (!parent) {
  return err(`找不到主线任务 ${parentQuestId}，里程碑不可凭空追加`);
  }
  if (parent.type !== "mainline") {
  return err(`任务「${parent.title}」不是主线，里程碑只能挂在主线任务下`);
  }
  if (parent.status !== "proposed") {
  return err(
  `主线「${parent.title}」已经定稿（${parent.status}），里程碑不可再追加——拆解在提议阶段一次完成。`,
  );
  }
  const existing = db
  .select({ id: quests.id })
  .from(quests)
  .where(eq(quests.parentQuestId, parentQuestId))
  .all().length;
  if (existing >= config.mainline.milestone_cap) {
  return err(
  `主线「${parent.title}」的里程碑最多 ${config.mainline.milestone_cap} 个，已经拆满了。`,
  );
  }
  } else if (type === "mainline") {
  if (typeof args.parent_quest_id === "string" && args.parent_quest_id) {
  return err("主线任务本身就是父任务，不能挂 parent_quest_id");
  }
  }

  let deadline: number | null = null;
  if (typeof args.deadline === "string" && args.deadline) {
  const t = new Date(args.deadline).getTime();
  if (Number.isNaN(t)) return err(`deadline 日期无法解析：${args.deadline}`);
  deadline = t;
  }

  const id = randomUUID();
  db.insert(quests)
  .values({
  id,
  userId,
  title,
  description:
  typeof args.description === "string" ? args.description : null,
  type: type as typeof quests.$inferInsert.type,
  // V1.5：类别落库，复核/异议管线的白名单校验依据
  category,
  primaryAttr: finalPrimary,
  primaryWeight,
  secondaryAttr: finalSecondary,
  secondaryWeight,
  attrReason,
  difficulty,
  status: "proposed",
  streak: 0,
  checkin: checkin ? 1 : 0,
  deadline,
  parentQuestId,
  createdAt: Date.now(),
  })
  .run();

  return {
  ok: true,
  data: {
  quest_id: id,
  title,
  type,
  status: "proposed",
  primary_attr: finalPrimary,
  secondary_attr: finalSecondary,
  difficulty,
  attr_reason: attrReason,
  },
  summary: `创建任务草稿「${title}」（${type}${checkin ? "·签到" : ""}，待确认）`,
  stateChanged: true,
  };
}

// ---------- respond_to_quest ----------

function execRespondToQuest(db: Db, userId: string, args: Args): ToolExecResult {
  const questId = args.quest_id as string;
  const action = args.action as string;
  const quest = db
  .select()
  .from(quests)
  .where(and(eq(quests.id, questId), eq(quests.userId, userId)))
  .get();
  if (!quest) return err(`找不到任务 ${questId}`);
  if (quest.status !== "proposed") {
  return err(`任务「${quest.title}」当前状态为 ${quest.status}，不能接受/拒绝`);
  }
  const next = action === "accept" ? "active" : "rejected";
  db.update(quests).set({ status: next }).where(eq(quests.id, questId)).run();

  // V2.0 主线：接受主线时，其提议中的里程碑一并激活（拆解一次定稿，逐个去完成）
  let activatedMilestones = 0;
  if (action === "accept" && quest.type === "mainline") {
  const result = db
  .update(quests)
  .set({ status: "active" })
  .where(and(eq(quests.parentQuestId, questId), eq(quests.status, "proposed")))
  .run();
  activatedMilestones = result.changes;
  }

  return {
  ok: true,
  data: {
  quest_id: questId,
  title: quest.title,
  status: next,
  ...(quest.type === "mainline" ? { milestones_activated: activatedMilestones } : {}),
  },
  summary:
  action === "accept"
  ? `接受委托「${quest.title}」${activatedMilestones ? `（同时激活 ${activatedMilestones} 个里程碑）` : ""}`
  : `拒绝委托「${quest.title}」`,
  stateChanged: true,
  };
}

// ---------- lookup_quests ----------

function execLookupQuests(db: Db, userId: string, args: Args): ToolExecResult {
  const status = args.status as string;
  const rows =
  status === "all"
  ? db.select().from(quests).where(eq(quests.userId, userId)).all()
  : db
  .select()
  .from(quests)
  .where(
  and(
  eq(quests.userId, userId),
  eq(
  quests.status,
  status as typeof quests.$inferSelect.status,
  ),
  ),
  )
  .all();
  const list = rows.map((q) => ({
  quest_id: q.id,
  title: q.title,
  type: q.type,
  status: q.status,
  streak: q.streak,
  difficulty: q.difficulty,
  primary_attr: q.primaryAttr,
  secondary_attr: q.secondaryAttr,
  deadline: q.deadline,
  }));
  return {
  ok: true,
  data: { quests: list, count: list.length },
  summary: `查询任务列表（${status}，共 ${list.length} 条）`,
  stateChanged: false,
  };
}

// ---------- settle_completion ----------

function execSettleCompletion(db: Db, userId: string, args: Args, ctx: ToolContext): ToolExecResult {
  const questId = args.quest_id as string;
  const completionRatio = args.completion_ratio as number;
  const confidence = args.confidence as number;
  const evidence = typeof args.evidence === "string" ? args.evidence : "";

  const quest = db
  .select()
  .from(quests)
  .where(and(eq(quests.id, questId), eq(quests.userId, userId)))
  .get();
  if (!quest) return err(`找不到任务 ${questId}`);
  // V2.0 主线：完成度由里程碑推进，不单独结算（结算入口在里程碑上）
  if (quest.type === "mainline") {
  return err(
  `「${quest.title}」是主线，由一串里程碑推进——逐个完成里程碑，主线会在最后一个里程碑结清。`,
  );
  }
  // V2.0 仪式变体：逾期补结算的卡片带裂纹蜡封（数据随留痕一起存）
  const wasOverdue = quest.status === "overdue";
  // DESIGN-DECISION: 逾期任务（overdue）允许补结算——用户隔天补汇报是常态，
  // 断签代价已由 streak 折损体现（cron/jobs.runOverdueSweep），此处不再二次惩罚。
  if (quest.status === "overdue") {
  reviveQuestAfterSettlement(db, questId);
  quest.status = "active";
  } else if (quest.status !== "active") {
  return err(`任务「${quest.title}」当前状态为 ${quest.status}，只有进行中的委托才能结算`);
  }
  if (typeof completionRatio !== "number" || completionRatio < 0 || completionRatio > 1.2) {
  return err("completion_ratio 须在 0~1.2 之间");
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
  return err("confidence 须在 0~1 之间");
  }
  // V3 被动技能修正（连击上限/超额上限/晨型人金币）
  const skillMods = getSkillModifiers(db, userId);
  // V3 每日事件：星夜（今天第一笔结算 XP 加成）
  const starryXpRatio = dailyFirstSettlementXpRatio(db, userId);
  // V3 每日事件：会长心情（当天结算金币加成）
  const dailyGold = dailyGoldRatio(db, userId);
  // confidence<0.5：拒绝结算，需追问
  if (confidence < 0.5) {
  return err(
  "判定置信度不足（<0.5），暂不能结算。请向用户追问一个关键细节（时长/数量/频次），或商议部分结算。",
  { need_follow_up: true },
  );
  }

  const todayStart = startOfToday();
  // daily 同日重复结算拒绝
  if (quest.type === "daily") {
  const todaySettled = db
  .select({ id: settlementLog.id })
  .from(settlementLog)
  .where(
  and(
  eq(settlementLog.questId, questId),
  eq(settlementLog.kind, "quest_complete"),
  gte(settlementLog.createdAt, todayStart),
  ),
  )
  .all();
  if (todaySettled.length > 0) {
  return err(`每日任务「${quest.title}」今日已结算过，明天再来。`);
  }
  }

  // 今日已结算 XP（软上限增量；口径统一由 getTodaySettledXp 定义）
  const todaySettledXp = getTodaySettledXp(db, userId);

  const result = settleQuest({
  type: quest.type,
  difficulty: quest.difficulty,
  streak: quest.streak,
  completionRatio,
  primaryAttr: quest.primaryAttr,
  primaryWeight: quest.primaryWeight,
  secondaryAttr: quest.secondaryAttr,
  secondaryWeight: quest.secondaryWeight,
  todaySettledXp,
  // V3 被动技能：连击上限 / 超额上限加成
  streakCapAdd: skillMods.streakCapAdd,
  overCapAdd: skillMods.overCapAdd,
  // V3 每日事件：星夜 XP 加成
  xpBonusRatio: starryXpRatio,
  });

  // V1.8 稀有奖励（once/weekly）：引擎掷骰只放大金币，XP 不动
  const rarityRoll = applyOnceBonus(result.goldAwarded, quest.type, ctx.rand);

  // V3 被动技能：晨型人（早上结算金币加成；本地时区 05:00–11:00）
  const morningHour = new Date().getHours();
  const morningBonus =
  morningHour >= 5 && morningHour < 11 ? skillMods.morningGoldRatio : 0;
  const goldAwarded = Math.round(
  rarityRoll.gold * (1 + morningBonus) * (1 + dailyGold),
  );
  const raritySuffix =
  rarityRoll.roll.rarity === "legendary"
  ? "（传说品质！！）"
  : rarityRoll.roll.rarity === "rare"
  ? "（稀有品质！）"
  : "";
  const before = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (!before) return err("角色数据缺失，请先完成初始化");

  const beforeLevels = {
  total: levelFromXp(before.totalXp),
  vitality: levelFromXp(before.vitalityXp),
  mind: levelFromXp(before.mindXp),
  willpower: levelFromXp(before.willpowerXp),
  wealth: levelFromXp(before.wealthXp),
  social: levelFromXp(before.socialXp),
  creativity: levelFromXp(before.creativityXp),
  };

  const split = result.attrSplit;
  const after = {
  totalXp: before.totalXp + result.xpAwarded,
  gold: before.gold + goldAwarded,
  vitalityXp: before.vitalityXp + (split.vitality ?? 0),
  mindXp: before.mindXp + (split.mind ?? 0),
  willpowerXp: before.willpowerXp + (split.willpower ?? 0),
  wealthXp: before.wealthXp + (split.wealth ?? 0),
  socialXp: before.socialXp + (split.social ?? 0),
  creativityXp: before.creativityXp + (split.creativity ?? 0),
  };

  const levelUps: { scope: string; from: number; to: number }[] = [];
  const afterLevels = {
  total: levelFromXp(after.totalXp),
  vitality: levelFromXp(after.vitalityXp),
  mind: levelFromXp(after.mindXp),
  willpower: levelFromXp(after.willpowerXp),
  wealth: levelFromXp(after.wealthXp),
  social: levelFromXp(after.socialXp),
  creativity: levelFromXp(after.creativityXp),
  };
  for (const scope of Object.keys(afterLevels) as (keyof typeof afterLevels)[]) {
  if (afterLevels[scope] > beforeLevels[scope]) {
  levelUps.push({ scope, from: beforeLevels[scope], to: afterLevels[scope] });
  }
  }

  // 评级突破（只升不降；XP 不减，故按等级计算值天然单调）：酬金 + 突破礼 + 称号
  // 共用 applyRankPromotion（突破礼=休整卷轴、留痕、记忆都在那里）
  let rankUp: {
  from: string;
  to: string;
  gold: number;
  items: { name: string; count: number }[];
  } | null = null;
  const promotion = applyRankPromotion(
  db,
  userId,
  before.totalXp,
  after.totalXp,
  questId,
  "结算触发评级突破",
  );
  if (promotion.from && promotion.to) {
  after.gold += promotion.gold;
  rankUp = {
  from: promotion.from,
  to: promotion.to,
  gold: promotion.gold,
  items: promotion.items.map((i) => ({ name: i.name, count: i.count })),
  };
  }

  // 更新角色面板
  db.update(character).set(after).where(eq(character.userId, userId)).run();

  // 更新任务状态：daily 连击 +1 并保持 active；once/weekly/milestone 置 completed
  const now = Date.now();
  if (quest.type === "daily") {
  db.update(quests)
  .set({ streak: quest.streak + 1, breakStreak: 0, lastCheckedAt: now })
  .where(eq(quests.id, questId))
  .run();
  } else {
  db.update(quests)
  .set({ status: "completed", completedAt: now })
  .where(eq(quests.id, questId))
  .run();
  }

  // 结算留痕
  const settlementId = randomUUID();
  const settlementAdjustments: Record<string, unknown> = {};
  if (rarityRoll.roll.rarity !== "common") {
  settlementAdjustments.rarity = rarityRoll.roll.rarity;
  settlementAdjustments.gold_multiplier = rarityRoll.roll.multiplier;
  }
  if (wasOverdue) settlementAdjustments.was_overdue = true;
  if (morningBonus > 0) settlementAdjustments.morning_bonus = morningBonus;
  if (dailyGold > 0) settlementAdjustments.daily_gold_ratio = dailyGold;
  if (starryXpRatio > 0) settlementAdjustments.starry_xp_ratio = starryXpRatio;
  db.insert(settlementLog)
  .values({
  id: settlementId,
  userId,
  questId,
  kind: "quest_complete",
  completionRatio,
  confidence,
  xpAwarded: result.xpAwarded,
  goldAwarded,
  attrSplitJson: JSON.stringify(result.attrSplit),
  adjustmentsJson:
  Object.keys(settlementAdjustments).length > 0
  ? JSON.stringify(settlementAdjustments)
  : null,
  llmReasoning: evidence || null,
  createdAt: now,
  })
  .run();

  // V2.0 主线推进：最后一个里程碑结清 → 主线达成 + 章节奖励（配置驱动）
  let mainlineComplete: { title: string; xp: number; gold: number } | null = null;
  if (quest.type === "mainline_milestone" && quest.parentQuestId) {
  const siblings = db
  .select()
  .from(quests)
  .where(eq(quests.parentQuestId, quest.parentQuestId))
  .all();
  const parent = db
  .select()
  .from(quests)
  .where(eq(quests.id, quest.parentQuestId))
  .get();
  const allDone =
  siblings.length > 0 && siblings.every((s) => s.status === "completed");
  if (allDone && parent && parent.status !== "completed") {
  const bonus = config.mainline.completion_bonus;
  const charNow = db
  .select()
  .from(character)
  .where(eq(character.userId, userId))
  .get();
  if (charNow) {
  const current = charNow as unknown as Record<string, number>;
  const attrCol = `${parent.primaryAttr}Xp`;
  const updates: Record<string, number> = {
  totalXp: current.totalXp + bonus.xp,
  gold: current.gold + bonus.gold,
  };
  updates[attrCol] = (current[attrCol] ?? 0) + bonus.xp;
  const promotion = applyRankPromotion(
  db,
  userId,
  current.totalXp,
  updates.totalXp,
  parent.id,
  `主线「${parent.title}」达成奖励触发评级晋升`,
  );
  updates.gold += promotion.gold;
  const bonusAt = Date.now();
  db.update(character)
  .set(updates as Partial<typeof character.$inferInsert>)
  .where(eq(character.userId, userId))
  .run();
  db.update(quests)
  .set({ status: "completed", completedAt: bonusAt })
  .where(eq(quests.id, parent.id))
  .run();
  db.insert(settlementLog)
  .values({
  id: randomUUID(),
  userId,
  questId: parent.id,
  kind: "mainline_complete",
  completionRatio: 1,
  confidence: 1,
  xpAwarded: bonus.xp,
  goldAwarded: bonus.gold,
  attrSplitJson: JSON.stringify({ [parent.primaryAttr]: bonus.xp }),
  adjustmentsJson: JSON.stringify({ milestones: siblings.length }),
  llmReasoning: `主线「${parent.title}」的 ${siblings.length} 个里程碑全部完成`,
  createdAt: bonusAt,
  })
  .run();
  const activeMaster = db
  .select({ id: saves.activeMasterId })
  .from(saves)
  .where(eq(saves.userId, userId))
  .get();
  db.insert(memory)
  .values({
  id: randomUUID(),
  userId,
  masterId: activeMaster?.id ?? null,
  category: "event",
  content: `达成主线「${parent.title}」`,
  createdAt: bonusAt,
  })
  .run();
  mainlineComplete = { title: parent.title, xp: bonus.xp, gold: bonus.gold };
  }
  }
  }

  // 开发期对账摘要
  console.log(
  `[settle] 「${quest.title}」ratio=${completionRatio} conf=${confidence} ` +
  `raw=${result.questXpRaw.toFixed(1)} xp=+${result.xpAwarded} gold=+${goldAwarded} ` +
  `split=${JSON.stringify(result.attrSplit)} mult=${JSON.stringify(result.multipliers)} ` +
  `today_settled=${todaySettledXp + result.xpAwarded} ` +
  (levelUps.length ? `level_ups=${JSON.stringify(levelUps)} ` : "") +
  (rankUp ? `rank_up=${rankUp.from}->${rankUp.to} +${rankUp.gold}g` : "") +
  (mainlineComplete
  ? `mainline_complete=「${mainlineComplete.title}」 +${mainlineComplete.xp}xp +${mainlineComplete.gold}g`
  : ""),
  );

  return {
  ok: true,
  data: {
  quest_id: questId,
  settlement_id: settlementId,
  title: quest.title,
  xp_awarded: result.xpAwarded,
  gold_awarded: goldAwarded,
  rarity: rarityRoll.roll.rarity,
  attr_split: result.attrSplit,
  streak: quest.type === "daily" ? quest.streak + 1 : quest.streak,
  level_ups: levelUps,
  rank_up: rankUp,
  mainline_complete: mainlineComplete,
  was_overdue: wasOverdue,
  },
  summary:
  `结算「${quest.title}」：+${result.xpAwarded} XP，+${goldAwarded} 金币${raritySuffix}` +
  (levelUps.length
  ? `；升级：${levelUps.map((l) => `${l.scope} ${l.from}→${l.to}`).join("、")}`
  : "") +
  (rankUp ? `；评级晋升 ${rankUp.from}→${rankUp.to}` : "") +
  (mainlineComplete ? `；主线达成「${mainlineComplete.title}」` : ""),
  stateChanged: true,
  };
}

// ---------- query_character / add_memory ----------

function execQueryCharacter(db: Db, userId: string): ToolExecResult {
  const summary = getCharacterSummary(db, userId);
  // V2.0：附上抽屉里的礼物存货，会长才知道用户能送什么（避免无货硬送）
  const giftKeys = shopCatalog()
  .filter((i) => i.type === "gift")
  .map((i) => i.key);
  const heldGifts = db
  .select()
  .from(items)
  .where(eq(items.userId, userId))
  .all()
  .filter((r) => giftKeys.includes(r.itemKey) && r.count > 0)
  .map((r) => ({ item_key: r.itemKey, count: r.count }));
  return {
  ok: true,
  data: { ...summary, held_gifts: heldGifts },
  summary: `查询角色面板（Lv.${summary.totalLevel}，评级 ${summary.rank}）`,
  stateChanged: false,
  };
}

function execAddMemory(db: Db, userId: string, args: Args): ToolExecResult {
  const category = args.category as string;
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!isMemoryCategory(category)) {
  return err(`非法记忆类别：${category}`);
  }
  if (!content) return err("记忆内容不能为空");
  // P12：记忆写进当前（任务）会长的记忆书；重复条目自动去重
  const save = db
  .select({ id: saves.activeMasterId })
  .from(saves)
  .where(eq(saves.userId, userId))
  .get();
  const memoryId = addMemory(db, userId, save?.id ?? null, category, content);
  if (!memoryId) {
  return { ok: true, data: { category, content, duplicate: true }, summary: `这条${category}记忆已经记过了`, stateChanged: false };
  }
  return {
  ok: true,
  data: { memory_id: memoryId, category, content },
  summary: `记下一条${category}记忆`,
  stateChanged: false,
  };
}

// ---------- buy_item（V1.5 金币消耗口）----------

function execBuyItem(db: Db, userId: string, args: Args): ToolExecResult {
  const itemKey = typeof args.item_key === "string" ? args.item_key.trim() : "";
  if (!itemKey) return err("缺少商品 item_key");
  const result = purchaseItem(db, userId, itemKey);
  if (!result.ok) return err(result.error);
  const { receipt } = result;
  const isGift = receipt.type === "gift";
  return {
  ok: true,
  data: { ...receipt, gift: isGift, held: receipt.count },
  summary: isGift
  ? `买下「${receipt.name}」放进抽屉（-${receipt.price} 金币，现持有 ${receipt.count} 份）`
  : `买下了「${receipt.name}」（${receipt.price} 金币）`,
  stateChanged: true,
  };
}

// ---------- gift_item（V2.0 礼物赠送 + 亲密度）----------

function execGiftItem(db: Db, userId: string, args: Args): ToolExecResult {
  const itemKey = typeof args.item_key === "string" ? args.item_key.trim() : "";
  if (!itemKey) return err("缺少礼物 item_key");
  const result = giftItem(db, userId, itemKey);
  if (!result.ok) return err(result.error);
  const { receipt } = result;
  return {
  ok: true,
  data: {
  item_key: receipt.itemKey,
  name: receipt.name,
  intimacy_stage: receipt.intimacyStage,
  intimacy_label: receipt.intimacyLabel,
  stage_up: receipt.stageUp,
  count_left: receipt.countLeft,
  },
  summary: receipt.stageUp
  ? `把「${receipt.name}」送给了会长，交情到了「${receipt.intimacyLabel}」`
  : `把「${receipt.name}」送给了会长`,
  stateChanged: true,
  };
}

// ---------- file_dispute（V1.5 异议通道）----------

/**
 * 登记异议并触发当场复核（conversation.ts 钩子拿到 dispute_id + settlement_id
 * 后调 runSettlementReview）。：对话入口与
 * 任务卡按钮入口都收束到这条管线。
 */
function execFileDispute(db: Db, userId: string, args: Args): ToolExecResult {
  const questId = typeof args.quest_id === "string" ? args.quest_id.trim() : "";
  const claim = typeof args.claim === "string" ? args.claim.trim() : "";
  if (!questId) return err("缺少 quest_id");
  if (!claim) return err("异议主张不能为空，请保留用户的原话要点");

  const quest = db
  .select()
  .from(quests)
  .where(and(eq(quests.id, questId), eq(quests.userId, userId)))
  .get();
  if (!quest) return err(`找不到任务 ${questId}`);

  const settlement = db
  .select()
  .from(settlementLog)
  .where(
  and(
  eq(settlementLog.questId, questId),
  eq(settlementLog.kind, "quest_complete"),
  ),
  )
  .orderBy(desc(settlementLog.createdAt))
  .get();
  if (!settlement) {
  return err(`「${quest.title}」还没有结算记录，无从异议。`);
  }

  const disputeId = randomUUID();
  db.insert(disputes)
  .values({
  id: disputeId,
  userId,
  settlementId: settlement.id,
  questId,
  claim,
  status: "open",
  createdAt: Date.now(),
  })
  .run();

  return {
  ok: true,
  data: {
  dispute_id: disputeId,
  settlement_id: settlement.id,
  quest_id: questId,
  quest_title: quest.title,
  claim,
  },
  summary: `登记异议：「${quest.title}」——${claim.slice(0, 40)}`,
  stateChanged: false,
  };
}

/** 工具执行入口（对象参数版）：AI SDK 的 toolCall.input 已是解析后的对象 */
export function executeToolArgs(
  db: Db,
  userId: string,
  name: string,
  args: Args,
  ctx: ToolContext,
): ToolExecResult {
  switch (name) {
  case "create_quest":
  return execCreateQuest(db, userId, args, ctx);
  case "respond_to_quest":
  return execRespondToQuest(db, userId, args);
  case "lookup_quests":
  return execLookupQuests(db, userId, args);
  case "settle_completion":
  return execSettleCompletion(db, userId, args, ctx);
  case "query_character":
  return execQueryCharacter(db, userId);
  case "add_memory":
  return execAddMemory(db, userId, args);
  case "buy_item":
  return execBuyItem(db, userId, args);
  case "gift_item":
  return execGiftItem(db, userId, args);
  case "file_dispute":
  return execFileDispute(db, userId, args);
  default:
  return err(`未知工具：${name}`);
  }
}

/** 工具执行入口（JSON 字符串参数版，保留给单测与旧调用方） */
export function executeTool(
  db: Db,
  userId: string,
  name: string,
  argsJson: string,
  ctx: ToolContext,
): ToolExecResult {
  let args: Args;
  try {
  args = argsJson ? (JSON.parse(argsJson) as Args) : {};
  } catch {
  return err(`工具参数不是合法 JSON：${argsJson.slice(0, 100)}`);
  }
  return executeToolArgs(db, userId, name, args, ctx);
}
