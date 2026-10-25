import { fetch } from "expo/fetch";

/**
 * LLM 底座（移动端）：直接请求 OpenAI 兼容 /chat/completions。
 * - 支持非流式 / SSE 流式 / function calling；
 * - DeepSeek 官方、OpenCode Go、自定义 OpenAI 兼容端点共用一套协议；
 * - Key 由 SecureStore 提供（见 server/secure.ts），请求只在本机发出。
 */

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const LOCAL_LLM_PROVIDER_ID = "local";
export const LOCAL_LLM_BASE_URL = "http://127.0.0.1:12306/v1";

export function isOpenCodeGo(baseUrl: string): boolean {
  return baseUrl.includes("opencode.ai/zen/go");
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("10.0.2.2") || baseUrl.includes("192.168.");
}

export interface ModelConfigInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  sessionId?: string;
  provider?: string;
}

export type LlmConfig = ModelConfigInput;

export class MissingApiKeyError extends Error {
  constructor() {
    super("会长还没拿到协会的印章（API Key）。去「设置 → 模型与渠道」填好 Key，回来就能说话了。");
    this.name = "MissingApiKeyError";
  }
}

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("还没填接口地址（设置 → 模型与渠道）");
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function headers(cfg: LlmConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (isOpenCodeGo(cfg.baseUrl)) {
    h["x-opencode-session"] = cfg.sessionId || "ngplus-guild-mobile";
    h["User-Agent"] = "ngplus-guild/1.0";
  }
  return h;
}

function timeoutController(ms: number, external?: AbortSignal): AbortController {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new Error("请求超时")), ms);
  const onAbort = () => c.abort(external?.reason);
  if (external) {
    if (external.aborted) c.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  (c as AbortController & { __timer?: ReturnType<typeof setTimeout> }).__timer = timer;
  return c;
}

function clearTimeoutOf(c: AbortController) {
  const t = (c as AbortController & { __timer?: ReturnType<typeof setTimeout> }).__timer;
  if (t) clearTimeout(t);
}

interface ChatChoiceMessage {
  content?: string | null;
  tool_calls?: LlmToolCall[];
}
interface ChatResponse {
  choices?: { message?: ChatChoiceMessage; finish_reason?: string }[];
  error?: { message?: string };
  message?: string;
}

function apiError(status: number, text: string): Error {
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as ChatResponse;
    detail = j.error?.message || j.message || detail;
  } catch {
    /* 非 JSON 错误体 */
  }
  return new Error(`接口返回 ${status}${detail ? `：${detail}` : ""}`);
}

export interface ChatOptions {
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason?: string;
}

function parseToolCalls(raw: LlmToolCall[] | undefined) {
  return (raw ?? [])
    .filter((c) => c?.function?.name)
    .map((c) => ({
      id: c.id || `call_${Math.random().toString(36).slice(2)}`,
      name: c.function.name,
      arguments: c.function.arguments ?? "{}",
    }));
}

/** 非流式一次调用。 */
export async function chatComplete(cfg: LlmConfig, opts: ChatOptions): Promise<ChatResult> {
  if (!cfg.model.trim()) throw new Error("还没填模型名");
  const ctrl = timeoutController(opts.timeoutMs ?? 200_000, opts.signal);
  try {
    const body: Record<string, unknown> = {
      model: cfg.model.trim(),
      messages: opts.messages,
      stream: false,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;

    const res = await fetch(endpoint(cfg.baseUrl), {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw apiError(res.status, text);
    let json: ChatResponse;
    try {
      json = JSON.parse(text) as ChatResponse;
    } catch {
      throw new Error("接口没有返回可解析的 JSON");
    }
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      finishReason: choice?.finish_reason,
    };
  } finally {
    clearTimeoutOf(ctrl);
  }
}

/** 流式调用：逐段回调正文；tool_calls 在流末汇总。 */
export async function chatStream(
  cfg: LlmConfig,
  opts: ChatOptions & { onDelta: (text: string) => void },
): Promise<ChatResult> {
  if (!cfg.model.trim()) throw new Error("还没填模型名");
  const ctrl = timeoutController(opts.timeoutMs ?? 200_000, opts.signal);
  try {
    const body: Record<string, unknown> = {
      model: cfg.model.trim(),
      messages: opts.messages,
      stream: true,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;

    const res = await fetch(endpoint(cfg.baseUrl), {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw apiError(res.status, await res.text().catch(() => ""));

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const json = (await res.json()) as ChatResponse;
      const choice = json.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (text) opts.onDelta(text);
      return { text, toolCalls: parseToolCalls(choice?.message?.tool_calls), finishReason: choice?.finish_reason };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = (await res.text()).trim();
      if (text) opts.onDelta(text);
      return { text, toolCalls: [] };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finishReason: string | undefined;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let json: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string;
        }[];
      };
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content) {
        full += delta.content;
        opts.onDelta(delta.content);
      }
      for (const [fallbackIndex, tc] of (delta.tool_calls ?? []).entries()) {
        const idx = typeof tc.index === "number" ? tc.index : fallbackIndex;
        const prev = calls.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.name += tc.function.name;
        if (tc.function?.arguments) prev.arguments += tc.function.arguments;
        calls.set(idx, prev);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer) handleLine(buffer);

    return {
      text: full,
      toolCalls: [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, c]) => c.name)
        .map(([, c]) => ({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, arguments: c.arguments || "{}" })),
      finishReason,
    };
  } finally {
    clearTimeoutOf(ctrl);
  }
}

/** 文本生成（翻译 / 锻造 / 场景提炼 / 连接测试共用）。 */
export async function generateText(
  cfg: LlmConfig,
  input: { system?: string; prompt: string; maxTokens?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ text: string }> {
  const messages: LlmMessage[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });
  const r = await chatComplete(cfg, {
    messages,
    maxTokens: input.maxTokens,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 120_000,
  });
  return { text: r.text };
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/** 结构化判定：模型不支持 response_format 也能用（提示词要求只输出 JSON）。 */
export async function generateJson(
  cfg: LlmConfig,
  input: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.system}\n只输出一个 JSON 对象，不要 markdown 代码围栏或解释。` },
    { role: "user", content: input.prompt },
  ];
  const r = await chatComplete(cfg, {
    messages,
    maxTokens: input.maxTokens ?? 1200,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  return extractJson(r.text);
}
