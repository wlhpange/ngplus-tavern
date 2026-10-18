import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  setSessionScene,
} from "@/server/chatSessions";
import { resolveAsset } from "@/server/assets";
import { saves } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** P10 聊天会话管理：列表 / 新建 / 改名 / 删除 */

function activeMasterId(
  db: ReturnType<typeof bootstrap>["db"],
  userId: string,
): string | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  return save?.activeMasterId ?? null;
}

export async function GET() {
  const { db, userId } = bootstrap();
  const masterId = activeMasterId(db, userId);
  if (!masterId) return NextResponse.json({ sessions: [] });
  return NextResponse.json({ sessions: listSessions(db, userId, masterId) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    sessionId?: string;
    title?: string;
    scene?: string | null;
  } | null;
  if (!body?.action) return NextResponse.json({ error: "缺少 action" }, { status: 400 });

  const { db, userId } = bootstrap();
  const masterId = activeMasterId(db, userId);
  if (!masterId) return NextResponse.json({ error: "还没有会长" }, { status: 400 });

  switch (body.action) {
    case "create": {
      const id = createSession(db, userId, masterId, body.title ?? "新的对话");
      return NextResponse.json({ ok: true, sessionId: id });
    }
    case "rename": {
      if (!body.sessionId) return bad("缺少 sessionId");
      const s = getSession(db, userId, body.sessionId);
      if (!s || s.masterId !== masterId) return bad("会话不存在");
      renameSession(db, userId, body.sessionId, body.title ?? "");
      return NextResponse.json({ ok: true });
    }
    case "setBackground": {
      if (!body.sessionId) return bad("缺少 sessionId");
      const s = getSession(db, userId, body.sessionId);
      if (!s || s.masterId !== masterId) return bad("会话不存在");
      const scene =
        typeof body.scene === "string" && body.scene.trim() ? body.scene.trim() : null;
      if (scene && !resolveAsset("background", scene)) return bad("背景文件不存在");
      setSessionScene(db, userId, body.sessionId, scene);
      return NextResponse.json({ ok: true });
    }
    case "delete": {
      if (!body.sessionId) return bad("缺少 sessionId");
      const s = getSession(db, userId, body.sessionId);
      if (!s || s.masterId !== masterId) return bad("会话不存在");
      const remaining = listSessions(db, userId, masterId).filter((x) => x.id !== body.sessionId);
      deleteSession(db, userId, body.sessionId);
      // 删掉当前唯一的会话后，保证还有一条可用
      const nextId = remaining[0]?.id ?? createSession(db, userId, masterId, "新的对话");
      return NextResponse.json({ ok: true, nextSessionId: nextId });
    }
    default:
      return bad(`未知 action：${body.action}`);
  }

  function bad(msg: string) {
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
