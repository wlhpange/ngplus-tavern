import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { getUserPersona, setUserPersona } from "@/server/userPersona";

export const dynamic = "force-dynamic";

/** P9 冒险者卡（用户自己的设定），两模式共用 */
export async function GET() {
  const { db } = bootstrap();
  return NextResponse.json({ persona: getUserPersona(db) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    brief?: string;
    description?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  const { db } = bootstrap();
  const persona = setUserPersona(db, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.brief !== undefined ? { brief: body.brief } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
  });
  return NextResponse.json({ ok: true, persona });
}
