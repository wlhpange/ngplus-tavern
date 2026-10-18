import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { createTestDb } from "../llm/helpers";
import {
  DEFAULT_IMAGE_CONFIG,
  getImageConfig,
  setImageSettings,
} from "../../src/server/image/config";
import {
  buildScenePrompt,
  buildMfluxArgs,
  applyLoraTrigger,
  generateImage,
  resolveMfluxBin,
  classifyMfluxError,
  ImageBackendError,
} from "../../src/server/image/mflux";
import { buildExtractionPrompt, extractScene, MAX_SCENE_CHARS } from "../../src/server/image/scene";

let db: Db;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("本地生图设置（mflux）", () => {
  it("默认关闭，默认 FLUX.2 klein 4B + q4 + 国内镜像", () => {
    const cfg = getImageConfig(db);
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toBe("flux2-klein-4b");
    expect(cfg.quantize).toBe(4);
    expect(cfg.hfEndpoint).toBe(DEFAULT_IMAGE_CONFIG.hfEndpoint);
    expect(cfg.hfEndpoint).toContain("hf-mirror");
  });

  it("保存后可读回，幂等写入", () => {
    setImageSettings(db, {
      enabled: true,
      model: "flux2-klein-4b",
      quantize: 8,
      mfluxBin: "/opt/homebrew/bin/mflux-generate-flux2",
      hfEndpoint: "https://hf-mirror.net",
      steps: 4,
      width: 768,
      height: 1024,
      style: "anime, soft light",
    });
    const cfg = getImageConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.quantize).toBe(8);
    expect(cfg.mfluxBin).toContain("mflux-generate-flux2");
    expect(cfg.hfEndpoint).toBe("https://hf-mirror.net");
    expect(cfg.style).toBe("anime, soft light");

    setImageSettings(db, { steps: 6 });
    expect(getImageConfig(db).steps).toBe(6);
    expect(getImageConfig(db).style).toBe("anime, soft light");
  });

  it("量化值只接受 4 / 8 / 0，其余回落到 4", () => {
    setImageSettings(db, { quantize: 0 });
    expect(getImageConfig(db).quantize).toBe(0);
    // 非法值经 setImageSettings 存成字符串，读回时回落 4
    setImageSettings(db, { quantize: 5 as unknown as 4 });
    expect(getImageConfig(db).quantize).toBe(4);
  });

  it("生图开关/模型支持环境变量兜底（启动器预设），面板保存过则以面板为准", () => {
    process.env.IMAGE_ENABLED = "1";
    process.env.IMAGE_MODEL = "z-image-turbo";
    try {
      const cfg = getImageConfig(db);
      expect(cfg.enabled).toBe(true);
      expect(cfg.model).toBe("z-image-turbo");
      setImageSettings(db, { enabled: false, model: "flux2-klein-4b" });
      const cfg2 = getImageConfig(db);
      expect(cfg2.enabled).toBe(false);
      expect(cfg2.model).toBe("flux2-klein-4b");
    } finally {
      delete process.env.IMAGE_ENABLED;
      delete process.env.IMAGE_MODEL;
    }
  });

  it("LoRA 环境变量兜底：面板没设时生效；面板设过则以面板为准", () => {
    process.env.IMAGE_LORA_PATH = "/tmp/env-lora.safetensors";
    process.env.IMAGE_LORA_MODEL = "z-image-turbo";
    process.env.IMAGE_LORA_TRIGGER = "envtrigger";
    process.env.IMAGE_LORA_SCALE = "1.1";
    try {
      let cfg = getImageConfig(db);
      expect(cfg.loraPath).toBe("/tmp/env-lora.safetensors");
      expect(cfg.loraModel).toBe("z-image-turbo");
      expect(cfg.loraTrigger).toBe("envtrigger");
      expect(cfg.loraScale).toBeCloseTo(1.1);

      // 面板设过（即使存空串）→ 环境变量不再覆盖
      setImageSettings(db, { loraPath: "/db/lora.safetensors" });
      expect(getImageConfig(db).loraPath).toBe("/db/lora.safetensors");
      setImageSettings(db, { loraPath: "" });
      expect(getImageConfig(db).loraPath).toBe("");
    } finally {
      delete process.env.IMAGE_LORA_PATH;
      delete process.env.IMAGE_LORA_MODEL;
      delete process.env.IMAGE_LORA_TRIGGER;
      delete process.env.IMAGE_LORA_SCALE;
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

describe("mflux 命令行拼装", () => {
  const cfg = { model: "flux2-klein-4b", steps: 4, width: 832, height: 1216, quantize: 4 as const };

  it("包含模型/提示词/尺寸/步数/种子/输出与量化，且不带负面词", () => {
    const args = buildMfluxArgs(cfg, "cinematic, room", "/tmp/out.png", 12345);
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    expect(val("--model")).toBe("flux2-klein-4b");
    expect(val("--prompt")).toBe("cinematic, room");
    expect(val("--width")).toBe("832");
    expect(val("--height")).toBe("1216");
    expect(val("--steps")).toBe("4");
    expect(val("--seed")).toBe("12345");
    expect(val("--output")).toBe("/tmp/out.png");
    expect(val("-q")).toBe("4");
    expect(args).not.toContain("--negative-prompt");
  });

  it("quantize=0 时不传 -q", () => {
    const args = buildMfluxArgs({ ...cfg, quantize: 0 }, "x", "/tmp/o.png", 1);
    expect(args).not.toContain("-q");
  });

  it("带参考图时追加 --image-paths", () => {
    const args = buildMfluxArgs(cfg, "x", "/tmp/o.png", 1, ["/data/backgrounds/bg.png"]);
    expect(args).toContain("--image-paths");
    expect(args[args.indexOf("--image-paths") + 1]).toBe("/data/backgrounds/bg.png");
  });

  it("无参考图时不带 --image-paths", () => {
    const args = buildMfluxArgs(cfg, "x", "/tmp/o.png", 1);
    expect(args).not.toContain("--image-paths");
  });
});

describe("LoRA 触发词", () => {
  it("挂了 LoRA 且有触发词时追加在最前", () => {
    expect(applyLoraTrigger("a cat", "/x/y.safetensors", "mystyle")).toBe("mystyle, a cat");
  });
  it("没有 LoRA 或没有触发词时原样返回", () => {
    expect(applyLoraTrigger("a cat", "", "mystyle")).toBe("a cat");
    expect(applyLoraTrigger("a cat", "/x/y.safetensors", "  ")).toBe("a cat");
  });
});

describe("mflux 可执行文件定位", () => {
  it("配置了完整路径就用它", () => {
    expect(resolveMfluxBin("/custom/mflux-generate-flux2", "mflux-generate-flux2")).toBe(
      "/custom/mflux-generate-flux2",
    );
  });

  it("没配置时自动探测或回落到命令名（都应以命令名结尾）", () => {
    const saved = process.env.MFLUX_BIN;
    delete process.env.MFLUX_BIN;
    try {
      expect(resolveMfluxBin("", "mflux-generate-flux2")).toMatch(/mflux-generate-flux2$/);
    } finally {
      if (saved !== undefined) process.env.MFLUX_BIN = saved;
    }
  });
});

describe("失败归类（classifyMfluxError）", () => {
  it("ENOENT → 提示安装", () => {
    const e = classifyMfluxError({ code: "ENOENT" }, "mflux-generate-flux2");
    expect(e).toBeInstanceOf(ImageBackendError);
    expect(e.message).toContain("没找到 mflux");
    expect(e.message).toContain("uv tool install mflux");
  });

  it("killed → 提示超时", () => {
    const e = classifyMfluxError({ killed: true }, "mflux-generate-flux2");
    expect(e.message).toContain("超时");
  });

  it("Metal OOM → 提示内存不足与量化", () => {
    const e = classifyMfluxError(
      { stderr: "RuntimeError: [metal::malloc] Resource limit exceeded" },
      "mflux-generate-flux2",
    );
    expect(e.message).toContain("内存不足");
    expect(e.message).toContain("4-bit");
  });

  it("SSL/handshake → 提示镜像/网络", () => {
    const e = classifyMfluxError(
      { stderr: "SSL: handshake operation timed out while downloading" },
      "mflux-generate-flux2",
    );
    expect(e.message).toContain("网络");
    expect(e.message).toContain("hf-mirror.com");
  });

  it("其它 → 带 stderr 尾部", () => {
    const e = classifyMfluxError(
      { stderr: "line1\nline2\nsomething broke" },
      "mflux-generate-flux2",
    );
    expect(e.message).toContain("mflux 执行失败");
    expect(e.message).toContain("something broke");
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

describe("generateImage", () => {
  it("找不到 mflux 时抛可读的 ImageBackendError", async () => {
    await expect(
      generateImage(
        {
          backend: "mflux",
          model: "flux2-klein-4b",
          steps: 4,
          width: 832,
          height: 1216,
          quantize: 4,
          mfluxBin: "/nonexistent/definitely-not-mflux-xyz-12345",
          hfEndpoint: "https://hf-mirror.com",
          apiBaseUrl: "",
          apiKey: "",
          apiModel: "",
        },
        { prompt: "x" },
      ),
    ).rejects.toBeInstanceOf(ImageBackendError);
  });

  it("backend=api：没填地址直接报错（走自定义接口分支）", async () => {
    await expect(
      generateImage(
        {
          backend: "api",
          model: "flux2-klein-4b",
          steps: 4,
          width: 512,
          height: 768,
          quantize: 4,
          mfluxBin: "",
          hfEndpoint: "",
          apiBaseUrl: "",
          apiKey: "",
          apiModel: "gpt-image-1",
        },
        { prompt: "x" },
      ),
    ).rejects.toThrow(/生图接口地址/);
  });
});
