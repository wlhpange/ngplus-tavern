import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { queryRecords, type RecordKind } from "@/server/records";

export const dynamic = "force-dynamic";

/**
 * 聊天记录归档（2026-09-27 定案）：
 * ?before=<createdAt> 游标翻页；?q= 关键词；?kind=all|chat|settlement；?limit=40
 * 返回倒序（最新在前）的消息与结算卡片流，客户端按月/日分组渲染。
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const sp = req.nextUrl.searchParams;

  const before = Number(sp.get("before"));
  const limit = Number(sp.get("limit"));
  const q = sp.get("q") ?? "";
  const kindParam = sp.get("kind") ?? "all";
  const kind: RecordKind =
    kindParam === "chat" || kindParam === "settlement" ? kindParam : "all";

  const result = queryRecords(db, userId, {
    before: Number.isFinite(before) && before > 0 ? before : null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    q: q.trim() || undefined,
    kind,
  });

  return NextResponse.json(result);
}
