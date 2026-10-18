import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import {
  addMemory,
  deleteMemory,
  deleteMemories,
  listMemories,
  setMemoryEnabled,
  updateMemory,
  isMemoryCategory,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
} from "@/server/memory";
import { listSessions } from "@/server/chatSessions";

export const dynamic = "force-dynamic";

/**
 * P12 记忆书管理（设置页用）。
 * GET  ?masterId=…            该会长的永久记忆 + 其酒馆对话列表
 *      ?sessionId=…            某段酒馆对话的私有记忆
 * POST 增删改：
 *   - add    { masterId, sessionId?, category, content }
 *   - update { id, content }
 *   - toggle { id, enabled }
 *   - delete { id }
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const masterId = req.nextUrl.searchParams.get("masterId");
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  return NextResponse.json({
    memories: listMemories(db, userId, masterId, sessionId),
    categories: MEMORY_CATEGORIES.map((c) => ({ id: c, label: MEMORY_CATEGORY_LABELS[c] ?? c })),
    // 该会长的酒馆对话（设置页选择「某段对话的记忆」用）
    sessions: masterId
      ? listSessions(db, userId, masterId).map((s) => ({
          id: s.id,
          title: s.title,
          messageCount: s.messageCount,
        }))
      : [],
  });
}

export async function POST(req: NextRequest) {
  const { db, userId } = bootstrap();
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    id?: string;
    ids?: string[];
    masterId?: string | null;
    sessionId?: string | null;
    category?: string;
    content?: string;
    enabled?: boolean;
  } | null;
  if (!body?.action) {
    return NextResponse.json({ error: "缺少 action" }, { status: 400 });
  }

  if (body.action === "deleteMany") {
    const n = deleteMemories(db, userId, Array.isArray(body.ids) ? body.ids : []);
    return NextResponse.json({ ok: true, deleted: n });
  }

  if (body.action === "add") {
    if (!isMemoryCategory(body.category)) {
      return NextResponse.json({ error: "未知的记忆类别" }, { status: 400 });
    }
    const id = addMemory(
      db,
      userId,
      body.masterId ?? null,
      body.category,
      body.content ?? "",
      body.sessionId ?? null,
    );
    if (!id) return NextResponse.json({ error: "内容为空，或这条记忆已经记过了" }, { status: 400 });
    return NextResponse.json({ ok: true, id });
  }

  if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  if (body.action === "update") {
    const ok = updateMemory(db, userId, body.id, body.content ?? "");
    if (!ok) return NextResponse.json({ error: "内容为空或条目不存在" }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "toggle") {
    const ok = setMemoryEnabled(db, userId, body.id, body.enabled !== false);
    if (!ok) return NextResponse.json({ error: "条目不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "delete") {
    const ok = deleteMemory(db, userId, body.id);
    if (!ok) return NextResponse.json({ error: "条目不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `未知 action：${body.action}` }, { status: 400 });
}
