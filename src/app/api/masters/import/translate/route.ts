import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import type { ImportedCard } from "@/server/cardImport";
import { startTranslateJob, getJob, cancelJob } from "@/server/translateJobs";

export const dynamic = "force-dynamic";

/**
 * P11 角色卡翻译任务（后台 + 进度）。
 * POST { card }        → 启动后台翻译，返回 { jobId }
 * GET  ?jobId=         → 查询进度 { status, done, total, error?, result? }
 * POST { jobId, action:"cancel" } → 取消
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    card?: ImportedCard;
    jobId?: string;
    action?: string;
  } | null;

  if (body?.action === "cancel" && body.jobId) {
    return NextResponse.json({ ok: cancelJob(body.jobId) });
  }
  if (!body?.card || typeof body.card !== "object") {
    return NextResponse.json({ error: "缺少 card" }, { status: 400 });
  }
  const { db, userId } = bootstrap();
  const jobId = startTranslateJob(db, userId, body.card);
  return NextResponse.json({ ok: true, jobId });
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
  return NextResponse.json(job);
}
