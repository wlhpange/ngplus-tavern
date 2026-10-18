import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { chatLog } from "@/server/db/schema";
import { getImageConfig } from "@/server/image/config";
import { buildScenePrompt, generateImage, ImageBackendError } from "@/server/image/mflux";
import { assetUrl, saveScene, sceneFilename } from "@/server/assets";
import { getSceneJob, startSceneJob, cancelSceneJob } from "@/server/image/jobs";

export const dynamic = "force-dynamic";

/**
 * 情景配图（后台任务版）。
 *
 *   POST   { messageId }            → 启动后台生成，**立即返回**，不随请求断开而中止
 *   POST   { action: "test", prompt } → 设置页连通性测试（同步）
 *   DELETE ?messageId=              → 停止生成：kill 后台 mflux 进程并把任务移出表
 *   GET    ?messageId=              → 查询状态 { status, url?, error? }
 *
 * 生图在服务端跑完并落盘（data/scenes/<消息id>.png）；是否已生成以**文件**为准，
 * 所以手机锁屏 / 切页 / 刷新后，只要回来查询就能恢复显示。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    messageId?: string;
    prompt?: string;
    action?: string;
  } | null;

  const { db, userId } = bootstrap();
  const cfg = getImageConfig(db);
  if (!cfg.enabled) {
    return NextResponse.json(
      { error: "本地生图还没开启。到「设置 → 本地生图」打开。" },
      { status: 400 },
    );
  }

  // 设置页测试：同步生成一张，不挂到任何消息
  if (body?.action === "test") {
    const scene = (body.prompt ?? "").trim() || "a quiet room at dusk, warm lamp light";
    const prompt = buildScenePrompt(cfg.style, scene);
    const startedAt = Date.now();
    try {
      const bytes = await generateImage(cfg, {
        prompt,
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
      const filename = saveScene(randomUUID(), bytes);
      return NextResponse.json({
        ok: true,
        url: assetUrl("scene", filename),
        prompt,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const messageId = typeof body?.messageId === "string" ? body.messageId : "";
  if (!messageId) return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });

  const msg = db
    .select()
    .from(chatLog)
    .where(and(eq(chatLog.id, messageId), eq(chatLog.userId, userId)))
    .get();
  if (!msg) return NextResponse.json({ error: "找不到这条消息" }, { status: 404 });

  const job = startSceneJob(
    db,
    userId,
    {
      id: msg.id,
      content: msg.content,
      masterId: msg.masterId,
      sessionId: msg.sessionId,
    },
    typeof body?.prompt === "string" ? body.prompt : undefined,
  );
  return NextResponse.json({ ok: true, status: job.status, startedAt: job.startedAt });
}

/** 停止某条消息的后台配图：中止生成进程 */
export async function DELETE(req: NextRequest) {
  const messageId = req.nextUrl.searchParams.get("messageId") ?? "";
  if (!messageId) return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });
  const { db } = bootstrap();
  const cancelled = cancelSceneJob(messageId, db);
  return NextResponse.json({ ok: true, cancelled });
}

/** 查询某条消息的配图状态（前台轮询 / 刷新恢复用） */
export async function GET(req: NextRequest) {
  const messageId = req.nextUrl.searchParams.get("messageId") ?? "";
  if (!messageId) return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });

  // 文件是真相：已生成就直接给 URL
  const filename = sceneFilename(messageId);
  if (filename) {
    return NextResponse.json({ ok: true, status: "done", url: assetUrl("scene", filename) });
  }
  const { db } = bootstrap();
  const job = getSceneJob(messageId, db);
  if (job?.status === "error") {
    return NextResponse.json({ ok: true, status: "error", error: job.error });
  }
  if (job && (job.status === "queued" || job.status === "running")) {
    return NextResponse.json({ ok: true, status: job.status, startedAt: job.startedAt });
  }
  return NextResponse.json({ ok: true, status: "idle" });
}

function errorResponse(e: unknown) {
  if (e instanceof ImageBackendError) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "生图失败" },
    { status: 500 },
  );
}
