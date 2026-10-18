import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageConfig } from "./config";
import { generateImageViaApi } from "./api";

/**
 * 本地生图客户端：mflux（MLX 原生，Apple Silicon）。
 *
 * 走**命令行**，不依赖常驻服务：每次点按钮 → 起一个 mflux 进程 → 出图 → 进程退出。
 * 好处是 start 脚本不用拉第二个服务、不占后台内存；代价是每张图有模型加载冷启动。
 *
 * 默认模型 FLUX.2 klein 4B（Apache-2.0，蒸馏版 4 步，快）。
 *   mflux-generate-flux2 --model flux2-klein-4b --prompt … --steps 4 -q 4 --output out.png
 * 注意：FLUX.2 不支持 --negative-prompt，所以提示词只有正向。
 */

const execFileAsync = promisify(execFile);

/** 生图失败：带中文可读信息，供界面直接展示 */
export class ImageBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageBackendError";
  }
}

/**
 * 把 mflux 的失败归类成可读、可操作的中文提示（导出以便单测）。
 * 覆盖：没装 / 超时 / 内存不足 / 网络下载 / 其它。
 */
export function classifyMfluxError(e: unknown, bin: string): ImageBackendError {
  const err = e as NodeJS.ErrnoException & {
    stderr?: string;
    stdout?: string;
    killed?: boolean;
    signal?: string;
    name?: string;
  };
  const blob = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim();
  const lower = blob.toLowerCase();

  if (err.code === "ENOENT") {
    return new ImageBackendError(
      `没找到 mflux（${bin}）。先一次性安装：在终端运行 \`uv tool install mflux\`，或在设置里填 mflux 的完整路径。`,
    );
  }
  if (err.killed || err.signal === "SIGTERM" || err.name === "AbortError") {
    return new ImageBackendError(
      "生图超时被中止（上限 30 分钟）。若这是首次运行，可能还在下载模型；确认网络/镜像可用后重试。",
    );
  }
  if (
    /out of memory|outofmemory|insufficient memory|resource limit|metal::malloc|kiogpu|command buffer|not enough memory/.test(
      lower,
    )
  ) {
    return new ImageBackendError(
      "内存不足：本地生图峰值约 10GB。请关掉其它占内存的程序（尤其本地 LLM），或到「本地生图」把量化改为 4-bit 后重试。",
    );
  }
  if (
    /handshake|ssl|connection|xet|huggingface|resolve\/main|proxy|temporary failure|name resolution/.test(
      lower,
    )
  ) {
    return new ImageBackendError(
      "模型下载 / 网络出错。确认「本地生图」里的 HF 镜像可用（默认 hf-mirror.com），或检查网络后重试。",
    );
  }
  const tail = blob.split("\n").slice(-3).join(" / ").slice(0, 300);
  return new ImageBackendError(
    `mflux 执行失败${tail ? `：${tail}` : ""}。可在终端手动运行一次该命令查看完整日志。`,
  );
}

export interface MfluxModelDef {
  /** 配置里存的值 */
  id: string;
  label: string;
  /** mflux 可执行文件名（纯文生图） */
  command: string;
  /** 图像条件生成（带参考图）的可执行文件名 */
  editCommand: string;
  /** 传给 --model 的值 */
  model: string;
  /** 蒸馏版默认步数 */
  steps: number;
  /** 是否支持参考图（图像条件生成）；Z-Image 无 edit 命令，置 false */
  supportsRefs?: boolean;
}

/** 支持的生图模型（加新模型只在这里登记） */
export const MFLUX_MODELS: MfluxModelDef[] = [
  {
    id: "flux2-klein-4b",
    label: "FLUX.2 klein 4B（4 步 · 快 · Apache-2.0）",
    command: "mflux-generate-flux2",
    editCommand: "mflux-generate-flux2-edit",
    model: "flux2-klein-4b",
    steps: 4,
  },
  {
    id: "z-image-turbo",
    label: "Z-Image turbo（9 步 · 6B · 快）",
    command: "mflux-generate-z-image-turbo",
    editCommand: "mflux-generate-z-image-turbo",
    model: "filipstrand/Z-Image-Turbo-mflux-4bit",
    steps: 9,
    supportsRefs: false,
  },
];

export function modelDef(id: string): MfluxModelDef {
  return MFLUX_MODELS.find((m) => m.id === id) ?? MFLUX_MODELS[0];
}

/** 情景图提示词：固定风格前缀 + 场景描述。纯函数，便于测试。 */
export function buildScenePrompt(style: string, scene: string): string {
  const s = scene.replace(/\s+/g, " ").trim();
  const parts = [style.trim(), s].filter((p) => p.length > 0);
  return parts.join(", ").slice(0, 1200);
}

/**
 * LoRA 触发词：很多 LoRA 需要专门的触发词才明显生效。挂 LoRA 且有触发词时，
 * 把触发词追加到提示词最前。纯函数，便于测试。
 */
export function applyLoraTrigger(
  prompt: string,
  loraPath: string | undefined,
  loraTrigger: string | undefined,
): string {
  const trigger = loraTrigger?.trim();
  if (!loraPath?.trim() || !trigger) return prompt;
  return `${trigger}, ${prompt}`;
}

/**
 * 拼 mflux 命令行参数。纯函数（便于单测）。
 * 只传确认支持的参数：--model/--prompt/--width/--height/--steps/--seed/--output/-q。
 */
export function buildMfluxArgs(
  cfg: Pick<ImageConfig, "model" | "steps" | "width" | "height" | "quantize"> & {
    loraPath?: string;
    loraScale?: number;
    loraModel?: string;
  },
  prompt: string,
  outputPath: string,
  seed: number,
  referencePaths: string[] = [],
): string[] {
  const def = modelDef(cfg.model);
  const args = [
    "--model",
    def.model,
    "--prompt",
    prompt,
    "--width",
    String(cfg.width),
    "--height",
    String(cfg.height),
    "--steps",
    String(cfg.steps || def.steps),
    "--seed",
    String(seed),
    "--output",
    outputPath,
  ];
  if (cfg.quantize === 4 || cfg.quantize === 8) {
    args.push("-q", String(cfg.quantize));
  }
  // LoRA：只在该 LoRA 属于当前模型时挂（避免切模型错配）
  if (cfg.loraPath && (!cfg.loraModel || cfg.loraModel === cfg.model)) {
    args.push("--lora", cfg.loraPath, String(cfg.loraScale ?? 0.8));
  }
  // 图像条件生成：把参考图路径交给 --image-paths（仅支持参考图的模型）
  if (def.supportsRefs !== false && referencePaths.length > 0) {
    args.push("--image-paths", ...referencePaths);
  }
  return args;
}

/**
 * 定位 mflux 可执行文件。优先配置的完整路径，其次常见安装位置，最后交给 PATH。
 * （Finder 双击启动的进程 PATH 可能不含 ~/.local/bin，所以显式找。）
 */
export function resolveMfluxBin(configured: string, command: string): string {
  const explicit = configured.trim();
  if (explicit) return explicit;
  const envBin = process.env.MFLUX_BIN;
  if (envBin && envBin.trim()) return envBin.trim();
  const candidates = [
    path.join(os.homedir(), ".local", "bin", command),
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return command; // 交给 PATH
}

export interface GenerateInput {
  prompt: string;
  /** 参考图（图像条件生成）；空则纯文生图 */
  referencePaths?: string[];
  signal?: AbortSignal;
}

/** 首次运行要下模型（约 15GB），给足超时 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function generateImage(
  cfg: Pick<
    ImageConfig,
    | "model"
    | "steps"
    | "width"
    | "height"
    | "quantize"
    | "mfluxBin"
    | "hfEndpoint"
    | "backend"
    | "apiBaseUrl"
    | "apiKey"
    | "apiModel"
  > & { loraPath?: string; loraScale?: number; loraModel?: string; loraTrigger?: string },
  input: GenerateInput,
): Promise<Buffer> {
  // 自定义生图接口：直接走 OpenAI 兼容后端，语义与本地 mflux 无关
  if (cfg.backend === "api") {
    return generateImageViaApi(cfg, { prompt: input.prompt, signal: input.signal });
  }
  const def = modelDef(cfg.model);
  const useRefs = def.supportsRefs !== false && (input.referencePaths?.length ?? 0) > 0;
  const command = useRefs ? def.editCommand : def.command;
  // 参考图走 edit 命令；显式配置的路径只对纯文生图命令生效，edit 命令按名自动探测
  const bin = useRefs ? resolveMfluxBin("", command) : resolveMfluxBin(cfg.mfluxBin, command);
  const outPath = path.join(os.tmpdir(), `ngplus-scene-${randomUUID()}.png`);
  const seed = Math.floor(Math.random() * 2_147_483_647);
  // LoRA 触发词：挂 LoRA 时追加在提示词最前（不改变 buildScenePrompt 的固定风格前缀）
  const prompt = applyLoraTrigger(input.prompt, cfg.loraPath, cfg.loraTrigger);
  const args = buildMfluxArgs(cfg, prompt, outPath, seed, input.referencePaths);

  // 注入 HF 端点：mflux 底层用 huggingface_hub，读 HF_ENDPOINT 决定下载地址。
  // 指向国内镜像即可免 VPN 下载模型。
  // 注意：huggingface_hub 2.0 默认走 Xet，而 Xet 会绕过 HF_ENDPOINT 直连 AWS CDN
  // （国内会失败），必须关掉才会走镜像。
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (cfg.hfEndpoint) env.HF_ENDPOINT = cfg.hfEndpoint;
  env.HF_HUB_DISABLE_XET = "1";
  // 走国内 HF 镜像直连：清掉代理环境变量，避免误用用户的 SOCKS/HTTP 代理
  // （会把模型下载流量算到用户的代理额度上；且 SOCKS 代理还要求 mflux 装 socksio）。
  for (const k of [
    "all_proxy",
    "ALL_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
  ]) {
    delete env[k];
  }

  try {
    await execFileAsync(bin, args, {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal: input.signal,
      env,
    });
  } catch (e) {
    throw classifyMfluxError(e, bin);
  }

  try {
    const bytes = fs.readFileSync(outPath);
    if (bytes.length === 0) throw new Error("empty");
    return bytes;
  } catch {
    throw new ImageBackendError("mflux 没有产出图片（可能被中断或内存不足）。");
  } finally {
    fs.rmSync(outPath, { force: true });
  }
}
