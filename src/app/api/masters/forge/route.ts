import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { modelFromDb } from "@/server/modelConfig";
import { forgeCardFromFields } from "@/server/personaForge";

export const dynamic = "force-dynamic";

/**
 * 新增会长 · AI 生成（V2.0）。
 *
 * 用户在上方任意一栏（名字 / 描述 / 性格 / 场景 / 开场白 / 标签）随便填几项，
 * 只按这些内容生成整张会长卡：只填名字就按名字起，只填场景就按场景起，
 * 多填几栏就一起参考。
 *
 * 这里只生成、不落库——把结果回填到表单让用户确认，再由 /api/masters/create
 * 落库上岗（可携带本接口返回的完整人格，保留 speech / backstory /
 * relationship_stages 等丰富字段）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMes?: string;
    tags?: string;
  } | null;

  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.trim().slice(0, max) : "";

  const input = {
    name: str(body?.name, 40),
    description: str(body?.description, 2000),
    personality: str(body?.personality, 400),
    scenario: str(body?.scenario, 800),
    firstMes: str(body?.firstMes, 800),
    tags: str(body?.tags, 200),
  };

  if (!Object.values(input).some(Boolean)) {
    return NextResponse.json(
      { error: "先随便填一栏（名字、描述、性格、场景、开场白或标签），AI 才能帮你起。" },
      { status: 400 },
    );
  }

  const { db } = bootstrap();
  try {
    const card = await forgeCardFromFields(modelFromDb(db), input);
    return NextResponse.json({ ok: true, card });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `AI 没能生成：${e.message.slice(0, 160)}`
            : "AI 没能生成，请再试一次。",
      },
      { status: 400 },
    );
  }
}
