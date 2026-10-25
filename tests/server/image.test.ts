import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { createTestDb } from "../llm/helpers";
import {
  DEFAULT_IMAGE_CONFIG,
  getImageConfig,
  setImageSettings,
} from "../../src/server/image/config";
import { buildScenePrompt, generateImage, ImageBackendError } from "../../src/server/image/generate";
import { buildExtractionPrompt, extractScene, MAX_SCENE_CHARS } from "../../src/server/image/scene";

let db: Db;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("生图设置（API）", () => {
  it("默认关闭、1024×1024、无接口", () => {
    const cfg = getImageConfig(db);
    expect(cfg.enabled).toBe(false);
    expect(cfg.width).toBe(DEFAULT_IMAGE_CONFIG.width);
    expect(cfg.height).toBe(DEFAULT_IMAGE_CONFIG.height);
    expect(cfg.apiBaseUrl).toBe("");
    expect(cfg.apiModel).toBe("");
  });

  it("保存后可读回，幂等写入", () => {
    setImageSettings(db, {
      enabled: true,
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      apiModel: "gpt-image-1",
      width: 832,
      height: 1216,
      style: "anime, soft light",
    });
    const cfg = getImageConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiBaseUrl).toBe("https://api.example.com/v1");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.apiModel).toBe("gpt-image-1");
    expect(cfg.width).toBe(832);
    expect(cfg.height).toBe(1216);
    expect(cfg.style).toBe("anime, soft light");

    setImageSettings(db, { width: 1024 });
    expect(getImageConfig(db).width).toBe(1024);
    expect(getImageConfig(db).apiModel).toBe("gpt-image-1");
  });

  it("尺寸越界会被夹到 256–2048", () => {
    setImageSettings(db, { width: 10, height: 99999 });
    expect(getImageConfig(db).width).toBe(256);
    expect(getImageConfig(db).height).toBe(2048);
  });

  it("环境变量兜底：面板没设时生效；面板设过则以面板为准", () => {
    process.env.IMAGE_ENABLED = "1";
    process.env.IMAGE_API_MODEL = "env-model";
    try {
      const cfg = getImageConfig(db);
      expect(cfg.enabled).toBe(true);
      expect(cfg.apiModel).toBe("env-model");

      setImageSettings(db, { enabled: false, apiModel: "db-model" });
      const cfg2 = getImageConfig(db);
      expect(cfg2.enabled).toBe(false);
      expect(cfg2.apiModel).toBe("db-model");
    } finally {
      delete process.env.IMAGE_ENABLED;
      delete process.env.IMAGE_API_MODEL;
    }
  });
});

describe("情景图提示词", () => {
  it("风格前缀 + 场景，压缩空白", () => {
    expect(buildScenePrompt("cinematic", "  a   dark   room ")).toBe(
      "cinematic, a dark room",
    );
  });

  it("空风格时只留场景", () => {
    expect(buildScenePrompt("", "sunset")).toBe("sunset");
  });
});

describe("场景提炼（extractScene）", () => {
  it("提炼提示词包含约束（只输出画面、去台词、保留姓名）", () => {
    const p = buildExtractionPrompt("她说：好无聊啊");
    expect(p).toContain("画面描述");
    expect(p).toContain("不要台词");
    expect(p).toContain("保留人物姓名");
    expect(p).toContain("好无聊啊");
  });

  it("带 context 时把人物/衣着设定纳入参考", () => {
    const p = buildExtractionPrompt("对话正文", "人物「子怡」：小麦色皮肤，穿吊带热裤");
    expect(p).toContain("参考设定");
    expect(p).toContain("吊带热裤");
    expect(p).toContain("对话正文");
  });

  it("无 context 时不出现参考设定段", () => {
    expect(buildExtractionPrompt("对话正文")).not.toContain("参考设定");
  });

  it("用注入的 call 返回提炼结果，并去掉首尾引号", async () => {
    const out = await extractScene(db, "随便一段", undefined, async () =>
      "“黄昏的影院，子怡坐在角落，暖光。”",
    );
    expect(out).toBe("黄昏的影院，子怡坐在角落，暖光。");
  });

  it("call 抛错时回退为压缩后的原文", async () => {
    const out = await extractScene(db, "  一段   带空白\n的原文  ", undefined, async () => {
      throw new Error("llm down");
    });
    expect(out).toBe("一段 带空白 的原文");
  });

  it("call 返回空时回退原文", async () => {
    const out = await extractScene(db, "原文在此", undefined, async () => "   ");
    expect(out).toBe("原文在此");
  });

  it("空内容直接返回空", async () => {
    expect(await extractScene(db, "   ")).toBe("");
  });

  it("强调动作与细节：提示词覆盖动作/表情/衣着/镜头", () => {
    const p = buildExtractionPrompt("对话");
    expect(p).toContain("动作与姿势");
    expect(p).toContain("表情与神态");
    expect(p).toContain("镜头感");
  });

  it("多场景处理：提示挑主场景、忽略最后一段的场景切换", () => {
    const p = buildExtractionPrompt("一整段回复……");
    expect(p).toContain("多个场景");
    expect(p).toContain("忽略最后一段");
  });

  it("要求一帧、50 字以内，并硬截断到 50 字", async () => {
    const p = buildExtractionPrompt("回复");
    expect(p).toContain("不超过 50 个字");
    expect(p).toContain("一帧");

    const long = "甲".repeat(80);
    const out = await extractScene(db, "原文", undefined, async () => long);
    expect(out.length).toBe(MAX_SCENE_CHARS);
    expect(out).toBe("甲".repeat(MAX_SCENE_CHARS));

    // 失败回退的原文也被压到 50 字以内
    const fallback = await extractScene(db, "乙".repeat(80), undefined, async () => {
      throw new Error("x");
    });
    expect(fallback.length).toBe(MAX_SCENE_CHARS);
  });

  it("adult=true 时要求如实定格、不审查；默认不含", async () => {
    expect(buildExtractionPrompt("对话")).not.toContain("不要审查");
    expect(buildExtractionPrompt("对话", undefined, { adult: true })).toContain("不要审查");

    let seen = "";
    await extractScene(
      db,
      "正文",
      undefined,
      async (p) => {
        seen = p;
        return "画面";
      },
      undefined,
      true,
    );
    expect(seen).toContain("不要审查");
  });
});

describe("generateImage（API）", () => {
  it("没填接口地址时抛可读的 ImageBackendError", async () => {
    await expect(
      generateImage(
        { width: 1024, height: 1024, apiBaseUrl: "", apiKey: "", apiModel: "gpt-image-1" },
        { prompt: "x" },
      ),
    ).rejects.toBeInstanceOf(ImageBackendError);
  });

  it("没填模型名时抛可读错误", async () => {
    await expect(
      generateImage(
        {
          width: 1024,
          height: 1024,
          apiBaseUrl: "https://api.example.com/v1",
          apiKey: "",
          apiModel: "",
        },
        { prompt: "x" },
      ),
    ).rejects.toThrow(/模型名/);
  });
});
