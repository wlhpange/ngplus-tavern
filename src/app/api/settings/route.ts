import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { bootstrap } from "@/server/bootstrap";
import {
  getLlmConfigState,
  modelFromDb,
  resolveLlmConfig,
  setLlmSettings,
  type LlmProvider,
} from "@/server/modelConfig";
import { createModel } from "@/server/llm/client";
import { getRpSettings, setRpEnabled } from "@/server/rp";
import { getChatMasterId, getChatMasterSetting, getActiveMasterId, listSelectableMasters, setChatMaster } from "@/server/masters";
import {
  getImageConfig,
  setImageSettings,
  type ImageConfig,
} from "@/server/image/config";
import { buildScenePrompt, generateImage, ImageBackendError, MFLUX_MODELS } from "@/server/image/mflux";
import { registerImageRun, finishImageRun, cancelImageRun } from "@/server/image/jobs";
import { assetUrl, saveScene } from "@/server/assets";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * 模型设置（V1.5，P11 简化）：参考开源智能体应用的自定义模型设置。
 * 两个渠道的 Key 已服务端明文内置（llm/keys.ts），前端只换渠道与模型。
 * GET：当前渠道 / 模型状态（Key 永不回传明文）。
 * POST：
 *   - action=save    保存 provider / model / judgeModel
 *   - action=test    用当前（或表单指定的）模型发一次最小 generateText 探活
 */
export async function GET() {
  const { db, userId } = bootstrap();
  return NextResponse.json({
    ...getLlmConfigState(db),
    rp: getRpSettings(db),
    image: getImageConfig(db),
    imageModels: MFLUX_MODELS.map((m) => ({ id: m.id, label: m.label })),
    // P12 聊天（酒馆）会长：显式设置（null=跟随）+ 生效 id + 可选会长列表
    chatMasterId: getChatMasterSetting(db, userId),
    chatMasterEffectiveId: getChatMasterId(db, userId),
    activeMasterId: getActiveMasterId(db, userId),
    masters: listSelectableMasters(db, userId).map((m) => ({ id: m.id, name: m.name })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    model?: string;
    judgeModel?: string;
    baseUrl?: string;
    apiKey?: string;
    rpEnabled?: boolean;
    provider?: LlmProvider;
    image?: Partial<ImageConfig>;
    imagePrompt?: string;
    chatMasterId?: string | null;
    token?: string;
  } | null;
  if (!body?.action) {
    return NextResponse.json({ error: "缺少 action" }, { status: 400 });
  }
  const { db, userId } = bootstrap();

  // P12 聊天会长：null = 跟随任务会长；否则指定一位（任务模式不受影响）
  if (body.action === "saveChatMaster") {
    const ok = setChatMaster(db, userId, body.chatMasterId ?? null);
    if (!ok) return NextResponse.json({ error: "会长不存在或已归档" }, { status: 400 });
    return NextResponse.json({
      ...getLlmConfigState(db),
      rp: getRpSettings(db),
      image: getImageConfig(db),
      chatMasterId: getChatMasterSetting(db, userId),
      chatMasterEffectiveId: getChatMasterId(db, userId),
      activeMasterId: getActiveMasterId(db, userId),
      masters: listSelectableMasters(db, userId).map((m) => ({ id: m.id, name: m.name })),
    });
  }
  // P4 R18 内容开关
  if (body.action === "saveRp") {
    const rp = setRpEnabled(db, body.rpEnabled === true);
    return NextResponse.json({ ...getLlmConfigState(db), rp });
  }

  if (body.action === "save") {
    setLlmSettings(db, {
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.judgeModel !== undefined ? { judgeModel: body.judgeModel } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    });
    return NextResponse.json(getLlmConfigState(db));
  }

  if (body.action === "test") {
    // 缺省合并已存值做探活（表单里可能刚改了地址/模型还没保存），不落库
    const stored = resolveLlmConfig(db);
    const provider = body.provider ?? stored.provider;
    const effectiveModel = body.model?.trim() || stored.model;
    // 自定义 API 没填模型名就别发请求：有些本地服务会因此卸载当前模型、去加载空名字而报错
    if (provider === "local" && !effectiveModel) {
      return NextResponse.json(
        { ok: false, error: "请先填模型名（可访问 {接口地址}/models 查看你的服务暴露的名字）。" },
        { status: 400 },
      );
    }
    const model = createModel({
      apiKey: body.apiKey?.trim() || stored.apiKey,
      baseUrl: body.baseUrl?.trim() || stored.baseUrl,
      model: effectiveModel,
      provider,
    });
    const startedAt = Date.now();
    try {
      await generateText({
        model,
        prompt: "收到请只回复两个字：收到",
        maxOutputTokens: 16,
        // 本地模型首次请求要预热，给宽一点
        abortSignal: AbortSignal.timeout(120_000),
      });
      return NextResponse.json({
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: effectiveModel,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      let friendly: string;
      if (/abort|timeout|timed out|超时/i.test(msg) || (e instanceof Error && e.name === "TimeoutError")) {
        friendly =
          "等待超时：本地模型可能还在加载/预热，或显存不足。稍等片刻再试；仍不行就看模型服务那边的日志。";
      } else if (/memory|kIOGPU|metal/i.test(msg)) {
        friendly = `模型服务显存不足：${msg.slice(0, 200)}`;
      } else {
        friendly = msg.slice(0, 300) || "连接失败，请稍后重试，或换个模型试试。";
      }
      return NextResponse.json({ ok: false, error: friendly }, { status: 400 });
    }
  }

  if (body.action === "probeModel") {
    // 设置页展示用：确认当前配置能解析出模型（不发起网络请求）
    try {
      modelFromDb(db);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "未配置" },
        { status: 400 },
      );
    }
  }

  // 本地生图（情景配图）：保存设置
  if (body.action === "saveImage") {
    const image = setImageSettings(db, body.image ?? {});
    return NextResponse.json({ ...getLlmConfigState(db), image });
  }

  // 本地生图：停止正在进行的测试生图（kill 后台 mflux 进程）
  if (body.action === "cancelTestImage") {
    const ok = cancelImageRun(body.token ?? "");
    return NextResponse.json({ ok });
  }

  // 本地生图：连通性 / 效果测试——生成一张样例图返回，不挂到任何消息
  if (body.action === "testImage") {
    const cfg = getImageConfig(db);
    if (!cfg.enabled) {
      return NextResponse.json(
        { ok: false, error: "先在「本地生图」里打开开关。" },
        { status: 400 },
      );
    }
    const scene = (body.imagePrompt ?? "").trim() || "a quiet room at dusk, warm lamp light";
    const prompt = buildScenePrompt(cfg.style, scene);
    const startedAt = Date.now();
    const token = typeof body.token === "string" && body.token ? body.token : null;
    const controller = token ? registerImageRun(token) : null;
    // 用户点停止 / 客户端断开 / 30 分钟超时，任一触发都 kill mflux
    const signal = AbortSignal.any(
      [req.signal, ...(controller ? [controller.signal] : []), AbortSignal.timeout(30 * 60 * 1000)],
    );
    try {
      const bytes = await generateImage(cfg, {
        prompt,
        signal,
      });
      const filename = saveScene(randomUUID(), bytes);
      return NextResponse.json({
        ok: true,
        url: assetUrl("scene", filename),
        prompt,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      // 用户点了停止：不算失败，返回 cancelled 让前端静默复位
      if (controller?.signal.aborted) {
        return NextResponse.json(
          { ok: false, cancelled: true, error: "已停止生图" },
          { status: 400 },
        );
      }
      const msg =
        e instanceof ImageBackendError
          ? e.message
          : e instanceof Error
            ? e.message.slice(0, 300)
            : "生图失败";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    } finally {
      if (token) finishImageRun(token);
    }
  }

  return NextResponse.json({ error: `未知 action：${body.action}` }, { status: 400 });
}
