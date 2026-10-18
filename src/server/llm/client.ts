/**
 * LLM 底座（V1.5 起切换到 Vercel AI SDK）。
 * - 默认 provider：@ai-sdk/deepseek（OpenAI 兼容 /chat/completions，支持 function calling）
 * - P8 新增 provider：OpenCode Go（https://opencode.ai/zen/go/v1，OpenAI 兼容），
 *   由 @ai-sdk/openai-compatible 承载；Go 要求客户端带 `x-opencode-session` 头。
 * - 对话主循环由 conversation.ts 以 generateText 单步驱动（编排权留在本项目）；
 *   结算复核等结构化判定由 reviewer.ts 以 generateObject 完成
 * - 配置来源：应用内「模型设置」（modelConfig.ts，存 app_settings 表，优先）
 *   → 环境变量（兜底）
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** 识别一条 baseUrl 是否指向 OpenCode Go（zen）端点 */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/**
 * P11 新增渠道：本地 LLM。
 * 任何 OpenAI 兼容的本地推理服务（LM Studio / llama.cpp / Ollama 的 /v1 等）
 * 都能挂在同一个地址上；默认按作者本机的 LM Studio 端点与模型预置。
 * Swapping the model / port only touches this block.
 */
export const LOCAL_LLM_PROVIDER_ID = "local";
export const LOCAL_LLM_BASE_URL = "http://127.0.0.1:12306/v1";

export function isOpenCodeGo(baseUrl: string): boolean {
  return baseUrl.includes("opencode.ai/zen/go");
}

/** 识别环回地址（本地 LLM 的兜底判断；正常走 provider 字段） */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost");
}

export interface ModelConfigInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 会话 id：传给 OpenCode Go 的 `x-opencode-session` 头（Go 用它优化路由与缓存）。
   * 单用户本地应用可传固定值或按会话生成；留空时用默认值。
   */
  sessionId?: string;
  /**
   * 渠道 id（modelConfig.ts 的 LlmProvider）。决定用哪个 SDK 组装：
   * opencode-go → 带 zen 头的 OpenAI 兼容；local → 通用 OpenAI 兼容；
   * 其余（deepseek 等）→ @ai-sdk/deepseek。
   */
  provider?: string;
}

/** 未配置 API key 时抛出，界面据此展示友好中文提示 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "会长还没拿到协会的印章（API Key）。去「设置」页填好 Key，回来就能说话了。",
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * 按配置组装模型实例。
 * - OpenCode Go（zen 端点）→ OpenAI 兼容 provider，并带上 x-opencode-session 头；
 * - 本地 LLM（provider=local 或环回地址）→ 通用 OpenAI 兼容 provider；
 * - 其余（DeepSeek 官方等）→ @ai-sdk/deepseek。
 */
export function createModel(config: ModelConfigInput): LanguageModel {
  if (isOpenCodeGo(config.baseUrl)) {
    const provider = createOpenAICompatible({
      name: OPENCODE_GO_PROVIDER_ID,
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      headers: {
        // Go 要求客户端自报样的会话头（见 opencode.ai/docs/go#where-can-i-use-it）
        "x-opencode-session": config.sessionId || "ngplus-guild-local",
        // 明确 UA：Go 会拒绝泛化的 SDK/HTTP 库 UA
        "User-Agent": "ngplus-guild/1.0",
      },
    });
    return provider(config.model);
  }
  if (config.provider === LOCAL_LLM_PROVIDER_ID || isLocalBaseUrl(config.baseUrl)) {
    const provider = createOpenAICompatible({
      name: LOCAL_LLM_PROVIDER_ID,
      baseURL: config.baseUrl,
      // 本地端点一般不看 Key，但 SDK 要求非空；留空时补占位
      apiKey: config.apiKey || "local",
    });
    return provider(config.model);
  }
  const deepseek = createDeepSeek({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return deepseek(config.model);
}

/**
 * 仅从环境变量组装模型实例（工具路径 / 测试用）。
 * 应用运行时请走 modelConfig.ts 的 modelFromDb（面板设置优先）。
 */
export function getModel(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const apiKey = env.OPENCODE_API_KEY || env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }
  if (env.OPENCODE_API_KEY) {
    return createModel({
      apiKey,
      baseUrl: env.OPENCODE_BASE_URL ?? OPENCODE_GO_BASE_URL,
      model: env.OPENCODE_MODEL ?? "deepseek-v4.1-flash",
    });
  }
  return createModel({
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
  });
}
