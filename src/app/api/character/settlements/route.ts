import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { queryRecords, type RecordItem } from "@/server/records";
import { settlementsToCsv, settlementsToMarkdown } from "@/server/export";

export const dynamic = "force-dynamic";

const EXPORT_LIMIT = 5000;

/**
 * 面板「月账单」数据与导出。
 * GET ?before=&limit=&kinds=quest_complete,review_adjustment → 分页结算流水
 * GET ?format=csv|md                                      → 全量导出（附件下载）
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const sp = req.nextUrl.searchParams;

  const format = sp.get("format");
  if (format === "csv" || format === "md") {
    const { items } = queryRecords(db, userId, {
      kind: "settlement",
      limit: EXPORT_LIMIT,
    });
    const records = items.map(
      (it) => (it as Extract<RecordItem, { type: "settlement" }>).settlement,
    );
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      return new NextResponse(settlementsToCsv(records), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="ngplus-settlements-${stamp}.csv"`,
        },
      });
    }
    return new NextResponse(settlementsToMarkdown(records), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="ngplus-settlements-${stamp}.md"`,
      },
    });
  }

  const before = Number(sp.get("before"));
  const limit = Number(sp.get("limit"));
  const kinds = (sp.get("kinds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { items, hasMore, nextBefore } = queryRecords(db, userId, {
    kind: "settlement",
    before: Number.isFinite(before) && before > 0 ? before : null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 30,
    settlementKinds: kinds.length ? kinds : undefined,
  });

  return NextResponse.json({
    settlements: items.map(
      (it) => (it as Extract<RecordItem, { type: "settlement" }>).settlement,
    ),
    hasMore,
    nextBefore,
  });
}
