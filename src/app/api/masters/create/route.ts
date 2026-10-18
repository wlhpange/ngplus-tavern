import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { createMasterFromFields } from "@/server/masters";
import type { PersonaJson } from "@/server/llm/prompts";

export const dynamic = "force-dynamic";

/**
 * 新增会长 · 手填角色卡字段（与「导入角色卡」同一套字段）。
 * 卡片就是数据：这里只做校验与落库，不含人设文案。
 */

const MAX = {
  name: 40,
  description: 2000,
  personality: 400,
  scenario: 800,
  firstMes: 800,
  greeting: 800,
  tags: 200,
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    card?: unknown;
    /** 可选的 AI 锻造结果（/api/masters/forge 返回的完整人格卡） */
    persona?: unknown;
  } | null;
  const c = asRecord(body?.card);

  const str = (k: string): string => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
  const name = str("name");
  if (!name) return bad("请先给这位会长起个名字");
  if (name.length > MAX.name) return bad(`名字最多 ${MAX.name} 个字`);

  const description = str("description");
  const firstMes = str("firstMes");
  if (!description && !firstMes) {
    return bad("至少写一段描述，或一句开场白——不然会长不知道该怎么说话");
  }
  if (description.length > MAX.description) return bad("描述太长了");

  const splitList = (v: string): string[] =>
    v
      .split(/[\n,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const aiPersona = asRecord(body?.persona) as Partial<PersonaJson>;

  const persona: PersonaJson = {
    // AI 锻造的丰富字段（speech / backstory / relationship_stages…）保留；
    // 表单里能看到的字段以用户当前填写为准（AI 生成后用户可能又改过）。
    ...(aiPersona as Partial<PersonaJson>),
    self_intro: description.slice(0, 120) || aiPersona.self_intro || undefined,
    description: description || undefined,
    personality: splitList(str("personality")).slice(0, 12),
    scenario: str("scenario") || undefined,
    first_mes: firstMes || undefined,
    alternate_greetings:
      Array.isArray(aiPersona.alternate_greetings) && aiPersona.alternate_greetings.length
        ? aiPersona.alternate_greetings
        : splitList(str("greetings")).slice(0, 4),
    tags: splitList(str("tags")).slice(0, 8),
    backstory: aiPersona.backstory,
  };

  const { db, userId } = bootstrap();
  try {
    const created = createMasterFromFields(db, userId, {
      name,
      persona,
      avatar: str("avatar") || null,
    });
    return NextResponse.json({ ok: true, masterId: created.id, name: created.name });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "新增失败" },
      { status: 400 },
    );
  }
}

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}
