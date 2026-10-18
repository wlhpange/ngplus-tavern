import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, like, lt } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { quests } from "@/server/db/schema";
import { repeatQuest } from "@/server/quests";
import { startOfMonth } from "@/server/util/time";

export const dynamic = "force-dynamic";

/**
 * 委托列表。
 * - 默认（对话板）：非完成委托全量 + 本月完成的委托 + 主线分组；
 *   更早的完成记录只回一个计数（olderCompletedCount），去档案室看。
 * - ?status=completed&limit=&before=&q= ：档案室分页（按 completedAt 倒序，可搜标题）。
 * - POST { action:"repeat", questId } ：一键重挂（复制成新的 proposed 草稿）。
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const limit = Number(sp.get("limit"));
  const before = Number(sp.get("before"));
  const q = sp.get("q")?.trim() ?? "";

  // ---- 档案室：已完成分页 ----
  if (status === "completed" && Number.isFinite(limit) && limit > 0) {
    const size = Math.min(Math.floor(limit), 100);
    const conditions = [eq(quests.userId, userId), eq(quests.status, "completed")];
    if (Number.isFinite(before) && before > 0) {
      conditions.push(lt(quests.completedAt, before));
    }
    if (q) conditions.push(like(quests.title, `%${q}%`));
    const rows = db
      .select()
      .from(quests)
      .where(and(...conditions))
      .orderBy(desc(quests.completedAt))
      .limit(size + 1)
      .all();
    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    return NextResponse.json({
      quests: page,
      hasMore,
      nextBefore: page.length ? page[page.length - 1].completedAt : null,
    });
  }

  // ---- 对话板：活跃优先，完成记录只带本月 ----
  const rows = db
    .select()
    .from(quests)
    .where(eq(quests.userId, userId))
    .orderBy(desc(quests.createdAt))
    .all();

  const monthStart = startOfMonth();
  const inBoard = rows.filter(
    (r) => r.status !== "completed" || (r.completedAt ?? 0) >= monthStart,
  );
  const olderCompletedCount = rows.filter(
    (r) => r.status === "completed" && (r.completedAt ?? 0) < monthStart,
  ).length;

  const mainlineRows = rows.filter((r) => r.type === "mainline");
  const mainlineIds = new Set(mainlineRows.map((r) => r.id));
  const mainlines = mainlineRows.map((m) => ({
    ...m,
    milestones: rows
      .filter((c) => c.parentQuestId === m.id)
      .sort((a, b) => a.createdAt - b.createdAt),
  }));
  const orphans = inBoard.filter(
    (r) => r.type === "mainline_milestone" && !mainlineIds.has(r.parentQuestId ?? ""),
  );
  const plain = inBoard.filter(
    (r) => r.type !== "mainline" && r.type !== "mainline_milestone",
  );

  return NextResponse.json({
    quests: [...plain, ...orphans],
    mainlines,
    olderCompletedCount,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    questId?: string;
  } | null;
  if (body?.action !== "repeat" || !body.questId) {
    return NextResponse.json({ error: "不支持的请求" }, { status: 400 });
  }
  const { db, userId } = bootstrap();
  const result = repeatQuest(db, userId, body.questId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, quest: result.quest });
}
