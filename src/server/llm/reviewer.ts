import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ReviewVerdict } from "../engine/review";

/**
 * 结算复核判定器（V1.5 校验复核管线，第二阶段）。
 *
 * 非人设的「系统复核员」：并排注入当初的预设映射与用户实际汇报，回答三问
 * （重分类 / 超额加成 / 计划外副产品）。结构化输出走 generateObject（zod），
 * 规则护栏在 engine/review.ts——判定器只提议，引擎才有执行权。
 *
 * 判定与生成分离：复核不加载会长
 * 人设与叙事层，判定质量与人设语气互不干扰。
 */

/** 判定器的结构化输出 schema（与 engine/review.ts 的 ReviewVerdict 对应） */
export const ReviewVerdictSchema = z.object({
  no_adjustment: z.boolean,
  xp_bonus_ratio: z.number().min(0).max(1),
  bonus_allocations: z
  .array(
  z.object({
  attr: z.string,
  share: z.number().min(0).max(1),
  reason: z.string,
  }),
  )
  .max(6),
  reclassification: z
  .object({ attr: z.string, reason: z.string })
  .nullable,
  narrative_hint: z.string().max(60),
  confidence: z.number().min(0).max(1),
});

export interface ReviewContext {
  questTitle: string;
  questType: string;
  /** 任务类别（决定允许属性；V1 老数据可能为 null） */
  category: string | null;
  /** 当初的属性映射理由（attr_reason，申诉/复核的解释依据） */
  attrReason: string | null;
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  difficulty: number;
  /** 用户汇报中的关键证据（settlement_log.llm_reasoning） */
  evidence: string | null;
  /** 原结算入账 XP 与属性分流 */
  awardedXp: number;
  attrSplit: Record<string, number>;
  /** 异议通道复用本管线时注入的用户主张 */
  disputeClaim?: string;
}

export interface SettlementReviewer {
  /** 对一次已落账的结算做收获复核。任何失败返回 null（fail-open，不阻断结算） */
  review(ctx: ReviewContext): Promise<ReviewVerdict | null>;
}

const ATTR_LABELS: Record<string, string> = {
  vitality: "体魄",
  mind: "心智",
  willpower: "意志",
  wealth: "财富",
  social: "社交",
  creativity: "创造",
};

function buildJudgeSystemPrompt(ctx: ReviewContext): string {
  const attrList = Object.keys(ATTR_LABELS)
  .map((k) => `${k}(${ATTR_LABELS[k]})`)
  .join("、");
  return [
  "你是「二周目协会」的结算复核员。会长刚完成一次委托结算，你负责收获复核：",
  "把「当初的预设映射」与「冒险者的实际汇报」并排审视，回答三问：",
  "1. 现实与计划是同一件事吗？性质判错时给 reclassification（新的主属性）。",
  "2. 投入是否显著超出计划？超出时给 xp_bonus_ratio（0~0.5 的追加比例）。",
  "3. 有没有计划外的副产品？有则用 bonus_allocations 追加属性分配并写明理由。",
  `属性只能用：${attrList}。willpower（意志）一律不碰——意志经验由系统按连击数据独占计算。`,
  "硬规则：复核只加不减、不动金币；拿不准就 no_adjustment=true。",
  "narrative_hint 是一句不超过 30 字、给人看的评语，禁止出现任何数值。",
  "confidence 是你对本次复核判断本身的置信度（0~1），不确定时调低。",
  ].join("\n");
}

function buildJudgeUserPrompt(ctx: ReviewContext): string {
  const lines = [
  "【当初的预设映射（任务卡）】",
  `委托：「${ctx.questTitle}」（${ctx.questType}，难度 ${ctx.difficulty}）`,
  ctx.category ? `类别：${ctx.category}` : "类别：（老数据未记录，按主属性推断）",
  `主属性：${ctx.primaryAttr} × ${ctx.primaryWeight}` +
  (ctx.secondaryAttr ? `；辅属性：${ctx.secondaryAttr} × ${ctx.secondaryWeight ?? ""}` : ""),
  `映射理由：${ctx.attrReason ?? "（未记录）"}`,
  "",
  "【冒险者的实际汇报】",
  ctx.evidence ?? "（未留痕）",
  "",
  "【已落账的结算结果】",
  `入账 XP：${ctx.awardedXp}`,
  `属性分流：${Object.entries(ctx.attrSplit)
  .map(([k, v]) => `${k}+${v}`)
  .join("、")}`,
  ];
  if (ctx.disputeClaim) {
  lines.push("", "【用户对本次结算提出异议】", ctx.disputeClaim, "（请针对异议重新审视上面的三问）");
  }
  return lines.join("\n");
}

export class DeepSeekReviewer implements SettlementReviewer {
  /** 模型由调用方注入（modelConfig.modelFromDb 的结果，面板设置优先） */
  constructor(private readonly model: LanguageModel) {}

  async review(ctx: ReviewContext): Promise<ReviewVerdict | null> {
  try {
  const { object } = await generateObject({
  model: this.model,
  schema: ReviewVerdictSchema,
  system: buildJudgeSystemPrompt(ctx),
  prompt: buildJudgeUserPrompt(ctx),
  // 复核不得阻塞对话：30 秒拿不到判定就放弃（fail-open）
  abortSignal: AbortSignal.timeout(30_000),
  });
  return object as ReviewVerdict;
  } catch (e) {
  console.error(
  "[reviewer] 复核判定失败（fail-open，维持原判）：",
  e instanceof Error ? e.message : e,
  );
  return null;
  }
  }
}

export function createDeepSeekReviewer(model: LanguageModel): SettlementReviewer {
  return new DeepSeekReviewer(model);
}

// ------------------------------------------------------------------
// 记忆复核（V1.7）：会长想写入长期记忆的内容，由独立复核员把关。
// 虚构/不值得/冗长 → 修正或驳回；任何失败 fail-open（照原样保留）。

export const MemoryVerdictSchema = z.object({
  action: z.enum(["keep", "correct", "discard"]),
  content: z.string().max(160).optional,
  reason: z.string().max(80),
});

export interface MemoryReviewInput {
  category: string;
  content: string;
  /** 近端对话摘要，供复核员核对记忆是否属实 */
  context: string;
}

export interface MemoryVerdict {
  action: "keep" | "correct" | "discard";
  /** action=correct 时的修正稿 */
  content?: string;
  reason: string;
}

export interface MemoryReviewer {
  review(input: MemoryReviewInput): Promise<MemoryVerdict | null>;
}

const MEMORY_SYSTEM = [
  "你是「二周目协会」的记忆复核员。会长想把一条关于冒险者的信息写入长期记忆。",
  "对照对话上下文回答：这条记忆是否属实、是否值得长期记住、是否够精简。",
  "输出 action：keep（属实且值得）/ correct（属实但要修正措辞，给 content）/ discard（虚构、无关紧要或与上下文矛盾）。",
  "reason 是给会长看的一句话（30 字内）。拿不准就 keep——记忆宁多勿错杀。",
].join("\n");

export class DeepSeekMemoryReviewer implements MemoryReviewer {
  constructor(private readonly model: LanguageModel) {}

  async review(input: MemoryReviewInput): Promise<MemoryVerdict | null> {
  try {
  const { object } = await generateObject({
  model: this.model,
  schema: MemoryVerdictSchema,
  system: MEMORY_SYSTEM,
  prompt: [
  "【对话上下文（近几条）】",
  input.context,
  "",
  "【会长想记下的记忆】",
  "类别：" + input.category,
  "内容：" + input.content,
  ].join("\n"),
  abortSignal: AbortSignal.timeout(20_000),
  });
  return object as MemoryVerdict;
  } catch (e) {
  console.error(
  "[memory-reviewer] 记忆复核失败（fail-open，照原样保留）：",
  e instanceof Error ? e.message : e,
  );
  return null;
  }
  }
}

export function createMemoryReviewer(model: LanguageModel): MemoryReviewer {
  return new DeepSeekMemoryReviewer(model);
}

// ------------------------------------------------------------------
// P12 记忆抽取（聊天每轮后台）：从最近的对话里挑出值得长期记住的事，
// 结构化输出后由 memory.ts 查重落库。任何失败返回空数组（fail-open）。

export const ExtractedMemorySchema = z.object({
  memories: z
    .array(
      z.object({
        category: z.enum(["profile", "preference", "event", "goal", "story", "relationship"]),
        content: z.string().max(160),
      }),
    )
    .max(6),
});

export interface MemoryExtractInput {
  /** 会长名字（让抽取结果写清「谁」） */
  masterName: string;
  /** 最近的对话（纯文本，正序） */
  transcript: string;
}

export interface MemoryExtractor {
  extract(input: MemoryExtractInput): Promise<{ category: string; content: string }[]>;
}

const EXTRACT_SYSTEM = [
  "你是「二周目协会」的记忆整理员。阅读会长与冒险者最近的对话，挑出值得长期记住、以后聊天会用到的信息。",
  "可记录的类别：",
  "- profile：冒险者本人的稳定信息（身份、处境、习惯）。",
  "- preference：偏好、厌恶、口头习惯。",
  "- event：发生过的具体事件（限一件一句话）。",
  "- goal：冒险者想达成的事。",
  "- story：角色扮演的剧情进展（关系变化、共同经历、约定、重要转折）。",
  "- relationship：两人的关系状态与称呼变化。",
  "只记长期有效的，忽略寒暄、当下一时的心情、重复信息。每条一句话、尽量具体（带人名/地名/数字），不超过 60 字。",
  "最多 6 条；没有值得记的就返回空数组。只输出 JSON，不要解释。",
].join("\n");

export class DeepSeekMemoryExtractor implements MemoryExtractor {
  constructor(private readonly model: LanguageModel) {}

  async extract(input: MemoryExtractInput): Promise<{ category: string; content: string }[]> {
    try {
      const { object } = await generateObject({
        model: this.model,
        schema: ExtractedMemorySchema,
        system: EXTRACT_SYSTEM,
        prompt: `【会长】${input.masterName}\n\n【最近的对话】\n${input.transcript}`,
        // 后台任务，不阻塞用户；超时就放弃本轮抽取
        abortSignal: AbortSignal.timeout(30_000),
      });
      return object.memories ?? [];
    } catch (e) {
      console.error(
        "[memory-extractor] 记忆抽取失败（跳过本轮）：",
        e instanceof Error ? e.message : e,
      );
      return [];
    }
  }
}

export function createMemoryExtractor(model: LanguageModel): MemoryExtractor {
  return new DeepSeekMemoryExtractor(model);
}