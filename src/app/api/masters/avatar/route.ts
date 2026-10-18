import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { setMasterAvatar } from "@/server/masters";
import { resolveAsset } from "@/server/assets";

export const dynamic = "force-dynamic";

/**
 * 给某位会长设置 / 清除头像（酒馆式：一个角色一张图）。
 * file 来自 /api/assets/upload?kind=avatar，或导入预览返回的 avatarFile。
 * file = null 表示清除头像（回落名字首字）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    masterId?: string;
    file?: string | null;
  } | null;
  const masterId = body?.masterId?.trim();
  if (!masterId) return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });

  const file = body?.file ?? null;
  if (file && !resolveAsset("avatar", file)) {
    return NextResponse.json({ error: "头像文件不存在" }, { status: 400 });
  }

  const { db, userId } = bootstrap();
  const ok = setMasterAvatar(db, userId, masterId, file);
  if (!ok) return NextResponse.json({ error: "会长不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
