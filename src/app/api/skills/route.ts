import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { listSkills, purchaseSkill } from "@/server/skills";

export const dynamic = "force-dynamic";

/**
 * 技能树（V3）。
 * GET：目录 + 金币/等级 + owned/levelOk/affordable
 * POST：{ skillKey } 解锁（确定性交易，直连 API 不经 LLM）
 */
export async function GET() {
  const { db, userId } = bootstrap();
  return NextResponse.json(listSkills(db, userId));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { skillKey?: string } | null;
  if (!body?.skillKey) {
    return NextResponse.json({ error: "缺少 skillKey" }, { status: 400 });
  }
  const { db, userId } = bootstrap();
  const result = purchaseSkill(db, userId, body.skillKey);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    skill: result.skill,
    goldLeft: result.goldLeft,
  });
}
