import { fetch } from "expo/fetch";

import type { ApiConfig } from "./settings";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type StreamOptions = {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
};

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("还没填接口地址（设置里填到 /v1 为止）");
  return `${base}/chat/completions`;
}

function headers(cfg: ApiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
  };
}

/**
 * 直连 OpenAI 兼容接口的流式对话。
 * 用 expo/fetch（支持 ReadableStream），不经过任何服务端。
 */
export async function streamChat(
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): Promise<string> {
  if (!cfg.model.trim()) throw new Error("还没填模型名");

  const res = await fetch(endpoint(cfg.baseUrl), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model.trim(),
      messages,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("接口没有返回内容");
    opts.onDelta?.(content);
    return content;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const text = (await res.text()).trim();
    if (!text) throw new Error("接口没有返回内容");
    opts.onDelta?.(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const json = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
      };
      const delta = json.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        opts.onDelta?.(delta);
      }
    } catch {
      /* 忽略非 JSON 行 */
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

  return full;
}

/** 设置页「测试连接」：非流式，只要一小段回复。 */
export async function testConnection(cfg: ApiConfig): Promise<string> {
  if (!cfg.model.trim()) throw new Error("还没填模型名");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(endpoint(cfg.baseUrl), {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        model: cfg.model.trim(),
        messages: [{ role: "user", content: "只回复两个字：收到" }],
        max_tokens: 16,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content?.trim() || "（接口返回了空内容）";
  } catch (e) {
    if (controller.signal.aborted) throw new Error("连接超时（60s）");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
