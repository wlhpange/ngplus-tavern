import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { createDb, type Db } from "../../src/server/db";
import { ensureSeed, LOCAL_USER_ID } from "../../src/server/db/seed";

/** 每个测试一个独立的内存库 + 幂等种子（local_user/character/薇拉/save） */
export function createTestDb(): { db: Db; userId: string } {
  const db = createDb(":memory:");
  ensureSeed(db, LOCAL_USER_ID);
  return { db, userId: LOCAL_USER_ID };
}

// ---------------------------------------------------------------------------
// 可编排的 mock LLM（V1.5 底座切换后基于 ai/test 的 MockLanguageModelV4）。
// 每次 generateText 弹出脚本队列的下一条回复，并记录规范化后的入参供断言。

export interface RecordedToolResult {
  toolName: string;
  /** output.type==='text' 的原始字符串（本项目工具结果均为 JSON 字符串） */
  value: string;
}

export interface RecordedMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** user/assistant 消息的纯文本（文本段拼接） */
  text: string;
  /** tool 消息携带的工具结果 */
  toolResults: RecordedToolResult[];
}

export interface RecordedCall {
  /** 全部 system 角色内容（顶层 system 参数 + messages 里的 system 注记）*/
  system: string;
  /** 顶层 system 参数本身（稳定前缀；用于验证前缀缓存不变式）*/
  systemParam: string;
  /** 除 system 外的全部消息（历史 + 回注 + 用户新消息） */
  messages: RecordedMessage[];
}

export type ScriptEntry =
  | { kind: "text"; content: string }
  | { kind: "tool-call"; id: string; name: string; args: Record<string, unknown> };

/** 脚本项：纯文本回复 */
export function text(content: string): ScriptEntry {
  return { kind: "text", content };
}

/** 脚本项：发起一次工具调用 */
export function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ScriptEntry {
  return { kind: "tool-call", id, name, args };
}

const MOCK_USAGE: LanguageModelV4GenerateResult["usage"] = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function entryToResult(entry: ScriptEntry): LanguageModelV4GenerateResult {
  if (entry.kind === "text") {
    return {
      content: [{ type: "text", text: entry.content }],
      finishReason: { unified: "stop", raw: undefined },
      usage: MOCK_USAGE,
      warnings: [],
    };
  }
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: entry.id,
        toolName: entry.name,
        input: JSON.stringify(entry.args),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: MOCK_USAGE,
    warnings: [],
  };
}

function normalizeMessage(m: LanguageModelV4CallOptions["prompt"][number]): RecordedMessage {
  if (m.role === "tool") {
    const toolResults: RecordedToolResult[] = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool-result") {
          toolResults.push({
            toolName: part.toolName,
            value: part.output.type === "text" ? part.output.value : JSON.stringify(part.output),
          });
        }
      }
    }
    return { role: "tool", text: "", toolResults };
  }
  const text = Array.isArray(m.content)
    ? m.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
    : (m.content ?? "");
  return { role: m.role, text, toolResults: [] };
}

/**
 * 可编排的 mock 模型：每次 generateText 弹出队列里的下一条回复。
 * 队列耗尽时抛错（LLM 被多调了一次）。
 * script 元素可以是静态脚本项，也可以是函数（读取规范化后的消息后动态生成，
 * 如引用上一步工具结果里的 quest_id）。
 */
export class ScriptedModel {
  readonly model: LanguageModel;
  calls: RecordedCall[] = [];
  private queue: Array<
    ScriptEntry | ((call: RecordedCall) => ScriptEntry)
  >;

  constructor(
    script: Array<ScriptEntry | ((call: RecordedCall) => ScriptEntry)>,
  ) {
    this.queue = [...script];
    const self = this;
    this.model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const systemMessages = options.prompt.filter((m) => m.role === "system");
        const system = systemMessages.map((m) => normalizeMessage(m).text).join("\n");
        // instructions（顶层 system 参数）始终排在最前，见 convert-to-language-model-prompt.ts
        const systemParam = systemMessages.length
          ? normalizeMessage(systemMessages[0]).text
          : "";
        const recorded: RecordedCall = {
          system,
          systemParam,
          messages: options.prompt
            .filter((m) => m.role !== "system")
            .map(normalizeMessage),
        };
        self.calls.push(recorded);
        const next = self.queue.shift();
        if (!next) {
          throw new Error("mock 脚本已耗尽，LLM 被多调了一次");
        }
        const entry = typeof next === "function" ? next(recorded) : next;
        return entryToResult(entry);
      },
    }) as unknown as LanguageModel;
  }
}

/** 从回注消息中取出某工具的执行结果（解析 JSON） */
export function toolResultOf(
  msgs: RecordedMessage[],
  name: string,
): Record<string, unknown> {
  for (const m of msgs) {
    const hit = m.toolResults.find((t) => t.toolName === name);
    if (hit) return JSON.parse(hit.value) as Record<string, unknown>;
  }
  throw new Error(`未找到工具 ${name} 的回注结果`);
}
