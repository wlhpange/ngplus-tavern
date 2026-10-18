import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { masters } from "@/server/db/schema";
import { parseCard } from "@/server/cards";

export const dynamic = "force-dynamic";

/** 读会长卡（编辑开场白用） */
export async function GET(req: NextRequest) {
  const masterId = req.nextUrl.searchParams.get("masterId");
  if (!masterId) return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });
  const { db, userId } = bootstrap();
  const master = db
    .select()
    .from(masters)
    .where(
      and(eq(masters.id, masterId), or(eq(masters.ownerId, userId), isNull(masters.ownerId))),
    )
    .get();
  if (!master) return NextResponse.json({ error: "会长不存在" }, { status: 404 });
  const card = parseCard(master.personaJson);
  return NextResponse.json({
    masterId,
    card: {
      first_mes: card.first_mes ?? "",
      alternate_greetings: card.alternate_greetings ?? [],
      description: card.description ?? "",
      scenario: card.scenario ?? "",
      tags: card.tags ?? [],
    },
  });
}

/**
 * 编辑会长卡字段（P9：开场白 swipe/编辑）。
 * 目前支持改：first_mes / alternate_greetings / description / scenario / tags。
 * 官方卡也允许编辑开场白（官方卡由应用管理，但开场白是观感层，放宽）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    masterId?: string;
    patch?: {
      first_mes?: string;
      alternate_greetings?: string[];
      description?: string;
      scenario?: string;
      tags?: string[];
    };
  } | null;
  if (!body?.masterId || !body.patch) {
    return NextResponse.json({ error: "缺少 masterId / patch" }, { status: 400 });
  }

  const { db, userId } = bootstrap();
  const master = db
    .select()
    .from(masters)
    .where(
      and(
        eq(masters.id, body.masterId),
        or(eq(masters.ownerId, userId), isNull(masters.ownerId)),
      ),
    )
    .get();
  if (!master) return NextResponse.json({ error: "会长不存在" }, { status: 404 });

  const card = parseCard(master.personaJson);
  const p = body.patch;

  if (p.first_mes !== undefined) {
    const v = p.first_mes.trim();
    card.first_mes = v || undefined;
  }
  if (p.alternate_greetings !== undefined) {
    card.alternate_greetings = p.alternate_greetings
      .map((g) => g.trim())
      .filter((g) => g.length > 0)
      .slice(0, 8);
  }
  if (p.description !== undefined) card.description = p.description.trim() || undefined;
  if (p.scenario !== undefined) card.scenario = p.scenario.trim() || undefined;
  if (p.tags !== undefined) card.tags = p.tags.map((t) => t.trim()).filter(Boolean).slice(0, 12);

  db.update(masters)
    .set({ personaJson: JSON.stringify(card) })
    .where(eq(masters.id, master.id))
    .run();

  return NextResponse.json({ ok: true });
}
