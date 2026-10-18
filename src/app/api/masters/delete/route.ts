import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { archiveMaster } from "@/server/masters";

export const dynamic = "force-dynamic";

/**
 * P1 归档（软删除）自定义会长。
 * 官方会长与当前在任的会长不可删；只归档，历史与消息里的名字仍可解析。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { masterId?: string } | null;
  if (!body?.masterId) {
    return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });
  }
  const { db, userId } = bootstrap();
  try {
    archiveMaster(db, userId, body.masterId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "删除失败" },
      { status: 400 },
    );
  }
}