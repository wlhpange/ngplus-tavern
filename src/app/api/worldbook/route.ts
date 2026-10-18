import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { masters } from "@/server/db/schema";
import {
  appendBookEntries,
  assignBook,
  createBook,
  deleteBook,
  deleteBookEntry,
  listBookEntries,
  listBooksForMaster,
  listMastersForBook,
  listWorldBooks,
  parseLorebook,
  renameBook,
  unassignBook,
  upsertBookEntry,
  estimateTokens,
  type WorldBookInsert,
} from "@/server/worldbook";

export const dynamic = "force-dynamic";

function isMasterAccessible(
  db: ReturnType<typeof bootstrap>["db"],
  userId: string,
  masterId: string,
): boolean {
  const row = db
    .select({ id: masters.id })
    .from(masters)
    .where(
      and(eq(masters.id, masterId), or(eq(masters.ownerId, userId), isNull(masters.ownerId))),
    )
    .get();
  return Boolean(row);
}

/** 书册 → 会长 id 列表 → 名字（管理界面展示"这本书被谁在用"） */
function masterNames(
  db: ReturnType<typeof bootstrap>["db"],
  ids: string[],
): { id: string; name: string }[] {
  if (ids.length === 0) return [];
  const rows = db.select({ id: masters.id, name: masters.name }).from(masters).all();
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => ({ id, name: map.get(id) ?? "?" }));
}

/**
 * P6 世界书管理（书册 + 多对多分配）。
 * GET  → 全部书册（含条目数）；?bookId → 该书的条目 + 使用它的会长
 * POST { action: "createBook", name }
 *      { action: "renameBook", bookId, name }
 *      { action: "deleteBook", bookId }
 *      { action: "assign", masterId, bookId }
 *      { action: "unassign", masterId, bookId }
 *      { action: "upsertEntry", bookId, entry }
 *      { action: "deleteEntry", id }
 *      { action: "import", bookId, json }
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const bookId = req.nextUrl.searchParams.get("bookId");
  if (bookId) {
    const entries = listBookEntries(db, userId, bookId);
    const usedBy = masterNames(db, listMastersForBook(db, userId, bookId));
    // P9 token 预算可视化：估算常驻条目的固定占用（每回合都注入）
    const constantTokens = entries
      .filter((e) => e.enabled && e.constant)
      .reduce((sum, e) => sum + estimateTokens(e.content), 0);
    const totalTokens = entries
      .filter((e) => e.enabled)
      .reduce((sum, e) => sum + estimateTokens(e.content), 0);
    return NextResponse.json({
      bookId,
      entries,
      usedBy,
      stats: { constantTokens, totalTokens, count: entries.length },
    });
  }
  return NextResponse.json({ books: listWorldBooks(db, userId) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    name?: string;
    bookId?: string;
    masterId?: string;
    fromMasterId?: string;
    id?: string;
    entry?: WorldBookInsert & { id?: string };
    json?: string;
  } | null;
  if (!body?.action) {
    return NextResponse.json({ error: "缺少 action" }, { status: 400 });
  }
  const { db, userId } = bootstrap();

  switch (body.action) {
    case "createBook": {
      const id = createBook(db, userId, body.name ?? "新世界书");
      return NextResponse.json({ ok: true, id });
    }
    case "renameBook": {
      if (!body.bookId) return bad("缺少 bookId");
      renameBook(db, userId, body.bookId, body.name ?? "");
      return NextResponse.json({ ok: true });
    }
    case "deleteBook": {
      if (!body.bookId) return bad("缺少 bookId");
      const ok = deleteBook(db, userId, body.bookId);
      return ok ? NextResponse.json({ ok: true }) : bad("世界书不存在");
    }
    case "assign": {
      if (!body.masterId || !body.bookId) return bad("缺少 masterId / bookId");
      if (!isMasterAccessible(db, userId, body.masterId)) return bad("会长不存在");
      assignBook(db, userId, body.masterId, body.bookId);
      return NextResponse.json({ ok: true });
    }
    // P9：把 A 会长的世界书整本复制给 B 会长（源书册挂载保持不变）
    case "cloneFromMaster": {
      if (!body.masterId || !body.fromMasterId) return bad("缺少 masterId / fromMasterId");
      if (!isMasterAccessible(db, userId, body.masterId)) return bad("目标会长不存在");
      if (!isMasterAccessible(db, userId, body.fromMasterId)) return bad("来源会长不存在");
      const sourceBooks = listBooksForMaster(db, userId, body.fromMasterId);
      if (sourceBooks.length === 0) return bad("来源会长没有世界书");
      let copied = 0;
      for (const b of sourceBooks) {
        const srcEntries = listBookEntries(db, userId, b.id);
        const newBookId = createBook(db, userId, `${b.name}（副本）`);
        appendBookEntries(
          db,
          userId,
          newBookId,
          srcEntries.map((e) => ({
            keys: e.keys,
            secondaryKeys: e.secondaryKeys,
            content: e.content,
            enabled: e.enabled,
            constant: e.constant,
            selective: e.selective,
            insertionOrder: e.insertionOrder,
            position: e.position,
            depth: e.depth,
            role: e.role,
            priority: e.priority,
            caseSensitive: e.caseSensitive,
            useRegex: e.useRegex,
            scanDepth: e.scanDepth,
            extensions: e.extensions,
          })),
        );
        assignBook(db, userId, body.masterId, newBookId);
        copied++;
      }
      return NextResponse.json({ ok: true, copied });
    }
    case "unassign": {
      if (!body.masterId || !body.bookId) return bad("缺少 masterId / bookId");
      unassignBook(db, userId, body.masterId, body.bookId);
      return NextResponse.json({ ok: true });
    }
    case "upsertEntry": {
      if (!body.bookId) return bad("缺少 bookId");
      const entry = body.entry;
      if (!entry || typeof entry.content !== "string" || !entry.content.trim()) {
        return bad("条目内容不能为空");
      }
      const id = upsertBookEntry(db, userId, body.bookId, {
        ...entry,
        keys: Array.isArray(entry.keys) ? entry.keys : [],
      });
      return NextResponse.json({ ok: true, id });
    }
    case "deleteEntry": {
      if (!body.id) return bad("缺少 id");
      deleteBookEntry(db, userId, body.id);
      return NextResponse.json({ ok: true });
    }
    case "import": {
      if (!body.bookId) return bad("缺少 bookId");
      if (typeof body.json !== "string" || !body.json.trim()) return bad("缺少世界书 JSON");
      let raw: unknown;
      try {
        raw = JSON.parse(body.json);
      } catch {
        return bad("不是合法 JSON");
      }
      const entries = parseLorebook(raw);
      if (entries.length === 0) return bad("没解析出任何条目");
      appendBookEntries(db, userId, body.bookId, entries);
      return NextResponse.json({ ok: true, imported: entries.length });
    }
    default:
      return bad(`未知 action：${body.action}`);
  }

  function bad(msg: string) {
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
