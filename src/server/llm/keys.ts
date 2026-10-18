/**
 * 渠道凭据。
 *
 * ⚠️ 开源版**不内置任何 Key**，一律从环境变量读取（见 `.env.example`）：
 * - DeepSeek 官方：`DEEPSEEK_API_KEY`
 * - OpenCode Go：`OPENCODE_API_KEY`
 * - 本地 LLM：占位（本地 OpenAI 兼容服务通常不校验 Key）
 *
 * 用 getter 每次读取 `process.env`（而非模块加载时快照），这样设置/测试里改动环境变量即可即时生效。
 * 未配置时对应渠道不可用：调用会抛 `MissingApiKeyError`，界面会提示去配置。
 * 请勿把真实 Key 提交进仓库。
 */
export const BUILTIN_API_KEYS = {
  /** DeepSeek 官方（https://api.deepseek.com） */
  get deepseek(): string {
    return process.env.DEEPSEEK_API_KEY ?? "";
  },
  /** OpenCode Go（https://opencode.ai/zen/go/v1） */
  get "opencode-go"(): string {
    return process.env.OPENCODE_API_KEY ?? "";
  },
  /** 本地 LLM（OpenAI 兼容端点，通常不校验 Key，仅占位避免 SDK 报缺 Key） */
  get local(): string {
    return "sk-local";
  },
} as const;
