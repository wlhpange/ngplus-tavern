import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { chatLog } from "@/server/db/schema";
import { deleteAsset, sceneFilename } from "@/server/assets";

export const dynamic = "force-dynamic";

/**
 * 单条消息删除。
 *   DELETE /api/chat/messages?id=<messageId>
 * 连带删掉该消息的情景配图文件（data/scenes/<id>.png），不留孤儿图。
 * 结算卡片是 settlement_log，不在本接口范围内。
 */
export async function DELETE(req: NextRequest) {
  const { db, userId } = bootstrap();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  const msg = db
    .select()
    .from(chatLog)
    .where(and(eq(chatLog.id, id), eq(chatLog.userId, userId)))
    .get();
  if (!msg) return NextResponse.json({ error: "找不到这条消息" }, { status: 404 });

  db.delete(chatLog).where(eq(chatLog.id, id)).run();

  const scene = sceneFilename(id);
  if (scene) deleteAsset("scene", scene);

  return NextResponse.json({ ok: true });
}
