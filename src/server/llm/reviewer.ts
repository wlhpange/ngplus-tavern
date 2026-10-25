import { generateJson, type LlmConfig } from "./client";
import type { ReviewVerdict } from "../engine/review";

/**
 * 结算复核 / 记忆复核 / 记忆抽取。
 * 判定与生成分离：复核员不加载会长人设；任何失败 fail-open。
 */

export interface ReviewContext {
  questTitle: string;
  questType: string;
  category: string | null;
  attrReason: string | null;
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  difficulty: number;
  evidence: string | null;
  awardedXp: number;
  attrSplit: Record<string, number>;
  disputeClaim?: string;
}

export interface SettlementReviewer {
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
  const attrList = Object.keys(ATTR_LABELS).map((k) => `${k}(${ATTR_LABELS[k]})`).join("、");
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
    "输出 JSON：{no_adjustment:boolean,xp_bonus_ratio:number,bonus_allocations:[{attr,share,reason}],reclassification:{attr,reason}|null,narrative_hint:string,confidence:number}",
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
    `属性分流：${Object.entries(ctx.attrSplit).map(([k, v]) => `${k}+${v}`).join("、")}`,
  ];
  if (ctx.disputeClaim) lines.push("", "【用户对本次结算提出异议】", ctx.disputeClaim, "（请针对异议重新审视上面的三问）");
  return lines.join("\n");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVerdict(raw: unknown): ReviewVerdict | null {
  const o = asRecord(raw);
  if (typeof o.no_adjustment !== "boolean" && typeof o.confidence !== "number") return null;
  const allocations = Array.isArray(o.bonus_allocations)
    ? o.bonus_allocations
        .map(asRecord)
        .filter((a) => typeof a.attr === "string")
        .map((a) => ({
          attr: a.attr as ReviewVerdict["bonus_allocations"][number]["attr"],
          share: Math.max(0, Math.min(1, num(a.share))),
          reason: typeof a.reason === "string" ? a.reason : "",
        }))
    : [];
  const rc = asRecord(o.reclassification);
  return {
    no_adjustment: o.no_adjustment === true,
    xp_bonus_ratio: Math.max(0, Math.min(1, num(o.xp_bonus_ratio))),
    bonus_allocations: allocations,
    reclassification:
      typeof rc.attr === "string" && rc.attr
        ? { attr: rc.attr as ReviewVerdict["bonus_allocations"][number]["attr"], reason: typeof rc.reason === "string" ? rc.reason : "" }
        : null,
    narrative_hint: typeof o.narrative_hint === "string" ? o.narrative_hint.slice(0, 60) : "",
    confidence: Math.max(0, Math.min(1, num(o.confidence))),
  };
}

export class DeepSeekReviewer implements SettlementReviewer {
  constructor(private readonly model: LlmConfig) {}

  async review(ctx: ReviewContext): Promise<ReviewVerdict | null> {
    try {
      const raw = await generateJson(this.model, {
        system: buildJudgeSystemPrompt(ctx),
        prompt: buildJudgeUserPrompt(ctx),
        maxTokens: 800,
        timeoutMs: 30_000,
      });
      return normalizeVerdict(raw);
    } catch (e) {
      console.error("[reviewer] 复核判定失败（fail-open，维持原判）：", e instanceof Error ? e.message : e);
      return null;
    }
  }
}

export function createDeepSeekReviewer(model: LlmConfig): SettlementReviewer {
  return new DeepSeekReviewer(model);
}

// ------------------------------------------------------------------ 记忆复核

export interface MemoryReviewInput {
  category: string;
  content: string;
  context: string;
}

export interface MemoryVerdict {
  action: "keep" | "correct" | "discard";
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
  '输出 JSON：{"action":"keep|correct|discard","content":"可选修正稿","reason":"一句话"}',
].join("\n");

export class DeepSeekMemoryReviewer implements MemoryReviewer {
  constructor(private readonly model: LlmConfig) {}

  async review(input: MemoryReviewInput): Promise<MemoryVerdict | null> {
    try {
      const raw = asRecord(
        await generateJson(this.model, {
          system: MEMORY_SYSTEM,
          prompt: ["【对话上下文（近几条）】", input.context, "", "【会长想记下的记忆】", "类别：" + input.category, "内容：" + input.content].join("\n"),
          maxTokens: 300,
          timeoutMs: 20_000,
        }),
      );
      const action = raw.action === "correct" || raw.action === "discard" ? raw.action : "keep";
      return {
        action,
        content: typeof raw.content === "string" ? raw.content.slice(0, 160) : undefined,
        reason: typeof raw.reason === "string" ? raw.reason.slice(0, 80) : "",
      };
    } catch (e) {
      console.error("[memory-reviewer] 记忆复核失败（fail-open，照原样保留）：", e instanceof Error ? e.message : e);
      return null;
    }
  }
}

export function createMemoryReviewer(model: LlmConfig): MemoryReviewer {
  return new DeepSeekMemoryReviewer(model);
}

// ------------------------------------------------------------------ 记忆抽取

export interface MemoryExtractInput {
  masterName: string;
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
  '输出 JSON：{"memories":[{"category":"profile","content":"..."}]}',
].join("\n");

export class DeepSeekMemoryExtractor implements MemoryExtractor {
  constructor(private readonly model: LlmConfig) {}

  async extract(input: MemoryExtractInput): Promise<{ category: string; content: string }[]> {
    try {
      const raw = asRecord(
        await generateJson(this.model, {
          system: EXTRACT_SYSTEM,
          prompt: `【会长】${input.masterName}\n\n【最近的对话】\n${input.transcript}`,
          maxTokens: 800,
          timeoutMs: 30_000,
        }),
      );
      const list = Array.isArray(raw.memories) ? raw.memories : [];
      return list
        .map(asRecord)
        .filter((m) => typeof m.content === "string" && m.content.trim())
        .map((m) => ({
          category: typeof m.category === "string" ? m.category : "event",
          content: String(m.content).slice(0, 160),
        }))
        .slice(0, 6);
    } catch (e) {
      console.error("[memory-extractor] 记忆抽取失败（跳过本轮）：", e instanceof Error ? e.message : e);
      return [];
    }
  }
}

export function createMemoryExtractor(model: LlmConfig): MemoryExtractor {
  return new DeepSeekMemoryExtractor(model);
}
