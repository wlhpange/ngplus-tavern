import type { LanguageModel } from "ai";
import type { SettlementReviewer, MemoryReviewer, MemoryExtractor } from "./reviewer";
import type { ToolContext } from "./tools";

/** 单轮对话工具调用循环上限（防失控） */
export const MAX_TOOL_ROUNDS = 5;
/** 单次模型调用超时（长回复 / 供应商挂死兜底） */
export const LLM_CALL_TIMEOUT_MS = 200_000;

/** AbortSignal.timeout 触发的超时（DOMException name=TimeoutError/AbortError） */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * 流式事件（route 转发给前端 SSE）。
 * - delta：模型新增的一段正文；
 * - reset：本轮其实是工具调用轮，先前 delta 出来的文字作废，请清掉重来。
 */
export type ConversationStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reset" };

export interface ConversationOptions {
  /** LLM 底座模型；默认从环境变量组装 DeepSeek（client.ts）。测试注入 mock model */
  model?: LanguageModel;
  /**
   * 流式回调。传了就用 streamText 并把增量文本交给它（route 用来转发 SSE）；
   * 不传（测试/批处理）则沿用 generateText，行为与旧版一致。
   */
  onEvent?: (e: ConversationStreamEvent) => void;
  /** 工具执行上下文（跟踪 create_quest 属性越界打回次数） */
  toolContext?: ToolContext;
  /** V3 每日事件掷骰随机源（测试注入固定序列；默认 Math.random） */
  dailyRand?: () => number;
  /**
   * 结算复核判定器（V1.5）。undefined = 默认 DeepSeek 判定器（无 key 时自动
   * 关闭复核，fail-open）；null = 显式禁用（测试用）。
   */
  reviewer?: SettlementReviewer | null;
  /**
   * 记忆复核判定器（V1.7）：把关 add_memory 的内容。undefined = 默认
   * （走判定模型，无 key 自动关闭）；null = 显式禁用。
   */
  memoryReviewer?: MemoryReviewer | null;
  /**
   * P12 聊天记忆抽取器：每轮后台从对话里抽取长期记忆。undefined = 默认
   * （走判定模型，无 key 自动关闭）；null = 显式禁用。
   */
  memoryExtractor?: MemoryExtractor | null;
}
