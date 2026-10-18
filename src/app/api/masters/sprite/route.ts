import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { setMasterSprite } from "@/server/masters";
import { sanitizeSprite } from "@/server/petSprite";
import type { PetDescriptor } from "@/lib/petCatalog";

export const dynamic = "force-dynamic";

/** 保存某位会长手动调好的像素小人形象参数。 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    masterId?: string;
    sprite?: Partial<PetDescriptor>;
  } | null;
  const masterId = body?.masterId?.trim();
  if (!masterId) return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });

  const sprite = sanitizeSprite(body?.sprite);
  const { db, userId } = bootstrap();
  const ok = setMasterSprite(db, userId, masterId, JSON.stringify(sprite));
  if (!ok) return NextResponse.json({ error: "会长不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, sprite });
}
