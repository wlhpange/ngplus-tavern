import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { appSettings } from "../../src/server/db/schema";
import {
  getLlmConfigState,
  setLlmSettings,
  resolveLlmConfig,
  maskKey,
  modelFromDb,
  OPENCODE_GO_MODELS,
  LLM_PROVIDERS,
} from "../../src/server/modelConfig";
import { BUILTIN_API_KEYS } from "../../src/server/llm/keys";
import { createTestDb } from "../llm/helpers";

let db: Db;

beforeEach(() => {
  // 开源版 Key 从环境变量读取：测试里注入假 Key（getter 每次读取，即时生效）
  process.env.DEEPSEEK_API_KEY = "sk-test-deepseek-0000";
  process.env.OPENCODE_API_KEY = "oc_sk_test_opencode_0000";
  ({ db } = createTestDb());
});

describe("模型配置（P11：Key 从环境变量读取，前端只换渠道与模型）", () => {
  it("默认状态：渠道=deepseek，Key 来自环境变量，模型落到官方默认", () => {
    const s = getLlmConfigState(db);
    expect(s.hasKey).toBe(true);
    expect(s.provider).toBe("deepseek");
    expect(s.baseUrl).toBe("https://api.deepseek.com");
    expect(s.model).toBe("deepseek-flash");
    expect(s.apiKeyMasked).toBe(maskKey(BUILTIN_API_KEYS.deepseek));
    expect(s.models.map((m) => m.id)).toEqual(["deepseek-flash"]);
  });

  it("内置 Key 不回传明文，只给掩码", () => {
    const s = getLlmConfigState(db);
    expect(s.apiKeyMasked).not.toContain(BUILTIN_API_KEYS.deepseek);
  });

  it("switch 到 opencode-go：baseUrl 落到 zen 端点，模型回落该渠道默认", () => {
    setLlmSettings(db, { provider: "opencode-go" });
    const s = getLlmConfigState(db);
    expect(s.provider).toBe("opencode-go");
    expect(s.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(s.model).toBe("deepseek-v4.1-flash");
    expect(s.apiKeyMasked).toBe(maskKey(BUILTIN_API_KEYS["opencode-go"]));
  });

  it("切回 DeepSeek：baseUrl / 模型回落官方默认", () => {
    setLlmSettings(db, { provider: "opencode-go" });
    setLlmSettings(db, { provider: "deepseek" });
    const s = getLlmConfigState(db);
    expect(s.provider).toBe("deepseek");
    expect(s.baseUrl).toBe("https://api.deepseek.com");
    expect(s.model).toBe("deepseek-flash");
  });

  it("换渠道时带上 model，则以 model 为准", () => {
    setLlmSettings(db, { provider: "opencode-go", model: "glm-5.3" });
    const s = getLlmConfigState(db);
    expect(s.model).toBe("glm-5.3");
  });

  it("存了不属于当前渠道的模型：回落到渠道默认", () => {
    setLlmSettings(db, { provider: "deepseek", model: "glm-5.3" }); // glm 只在 Go 有
    expect(getLlmConfigState(db).model).toBe("deepseek-flash");
    expect(resolveLlmConfig(db).model).toBe("deepseek-flash");
  });

  it("空串保存模型 = 清除，回落默认", () => {
    setLlmSettings(db, { provider: "opencode-go", model: "glm-5.3" });
    setLlmSettings(db, { model: "" });
    expect(getLlmConfigState(db).model).toBe("deepseek-v4.1-flash");
  });

  it("maskKey：长 Key 留前 3 后 4，短 Key 全打星", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-****cdef");
    expect(maskKey("short")).toBe("****");
  });

  it("modelFromDb：内置 Key 下可构建实例，不抛错", () => {
    expect(() => modelFromDb(db)).not.toThrow();
    setLlmSettings(db, { provider: "opencode-go", model: "kimi-k3" });
    expect(() => modelFromDb(db)).not.toThrow();
  });

  it("resolveLlmConfig：apiKey / baseUrl 取自渠道内置配置", () => {
    setLlmSettings(db, { provider: "opencode-go" });
    const cfg = resolveLlmConfig(db);
    expect(cfg.apiKey).toBe(BUILTIN_API_KEYS["opencode-go"]);
    expect(cfg.baseUrl).toBe(LLM_PROVIDERS["opencode-go"].baseUrl);
    expect(cfg.model).toBe("deepseek-v4.1-flash");
  });

  it("重复保存走更新而不是插重复行", () => {
    setLlmSettings(db, { model: "deepseek-flash" });
    setLlmSettings(db, { model: "deepseek-flash" });
    const rows = db.select().from(appSettings).where(eq(appSettings.key, "llm.model")).all();
    expect(rows).toHaveLength(1);
  });
});

describe("判定器独立模型（llm.judge_model，判定与生成分离）", () => {
  it("未配置 judgeModel：role=judge 跟随主模型", () => {
    setLlmSettings(db, { provider: "opencode-go", model: "glm-5.3" });
    const main = resolveLlmConfig(db, "main");
    const judge = resolveLlmConfig(db, "judge");
    expect(judge.model).toBe("glm-5.3");
    expect(judge.model).toBe(main.model);
    expect(getLlmConfigState(db).judgeModel).toBe("");
  });

  it("配置了 judgeModel：判定器走指定模型，主模型不受影响", () => {
    setLlmSettings(db, { provider: "opencode-go", model: "glm-5.3", judgeModel: "deepseek-v4-pro" });
    expect(resolveLlmConfig(db, "main").model).toBe("glm-5.3");
    expect(resolveLlmConfig(db, "judge").model).toBe("deepseek-v4-pro");
    expect(getLlmConfigState(db).judgeModel).toBe("deepseek-v4-pro");
  });

  it("judgeModel 空串保存 = 清除，回退跟随主模型", () => {
    setLlmSettings(db, { provider: "opencode-go", model: "glm-5.3", judgeModel: "deepseek-v4-pro" });
    setLlmSettings(db, { judgeModel: "" });
    expect(resolveLlmConfig(db, "judge").model).toBe("glm-5.3");
    const rows = db.select().from(appSettings).all();
    expect(rows.find((r) => r.key === "llm.judge_model")).toBeUndefined();
  });

  it("judgeModel 不在当前渠道清单里：视为跟随主模型", () => {
    setLlmSettings(db, { provider: "deepseek", judgeModel: "kimi-k3" });
    expect(getLlmConfigState(db).judgeModel).toBe("");
    expect(resolveLlmConfig(db, "judge").model).toBe("deepseek-flash");
  });
});

describe("OpenCode Go 模型清单（P11）", () => {
  it("默认状态暴露当前渠道（deepseek）的模型清单", () => {
    const s = getLlmConfigState(db);
    expect(s.providers.map((p) => p.id)).toEqual(["deepseek", "opencode-go", "local"]);
    expect(s.models).toEqual(LLM_PROVIDERS.deepseek.models);
  });

  it("Go 清单：30 个可用模型，含 DeepSeek / GLM / Qwen 等", () => {
    expect(OPENCODE_GO_MODELS).toHaveLength(30);
    const ids = OPENCODE_GO_MODELS.map((m) => m.id);
    expect(ids).toContain("deepseek-v4.1-flash");
    expect(ids).toContain("glm-5.3-flash");
    expect(ids).toContain("qwen3.8-max");
    expect(ids).toContain("kimi-k3");
    expect(ids).toContain("minimax-m3");
  });

  it("Go 清单剔除 /responses 协议模型（Grok / GPT / Muse Spark）", () => {
    const ids = OPENCODE_GO_MODELS.map((m) => m.id);
    for (const bad of [
      "grok-4.6",
      "grok-4.7",
      "gpt-5.6-luna",
      "gpt-6-luna",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
    ]) {
      expect(ids).not.toContain(bad);
    }
  });

  it("切到 Go 后状态里返回 Go 模型清单", () => {
    setLlmSettings(db, { provider: "opencode-go" });
    expect(getLlmConfigState(db).models).toBe(OPENCODE_GO_MODELS);
  });
});

describe("自定义 API 渠道", () => {
  it("切到自定义 API：默认地址为环回端点，模型/Key 由用户填（不再预置模型）", () => {
    setLlmSettings(db, { provider: "local" });
    const s = getLlmConfigState(db);
    expect(s.provider).toBe("local");
    expect(s.baseUrl).toBe("http://127.0.0.1:12306/v1");
    expect(s.model).toBe("");
    expect(s.hasKey).toBe(false);
    expect(s.models).toEqual([]);
  });

  it("保存地址/模型/Key 后读回；环回地址无 Key 也能建实例，公网无 Key 报错", () => {
    setLlmSettings(db, { provider: "local" });
    setLlmSettings(db, {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "my-model",
      apiKey: "sk-abc12345",
    });
    const s = getLlmConfigState(db);
    expect(s.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(s.model).toBe("my-model");
    expect(s.hasKey).toBe(true);
    expect(s.apiKeyMasked).toBe(maskKey("sk-abc12345"));

    const cfg = resolveLlmConfig(db);
    expect(cfg.provider).toBe("local");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(cfg.model).toBe("my-model");
    expect(() => modelFromDb(db)).not.toThrow();

    // 公网地址 + 清空 Key → 抛 MissingApiKeyError
    setLlmSettings(db, { baseUrl: "https://api.example.com/v1", apiKey: "" });
    expect(() => modelFromDb(db)).toThrow();
  });
});
