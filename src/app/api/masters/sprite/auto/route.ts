import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { autoMapSpriteForMaster } from "@/server/petSprite";

export const dynamic = "force-dynamic";

/**
 * 按会长卡描述自动生成形象参数（LLM 映射 + 关键词兜底），落库并返回。
 * 导入 / 新增会长成功后由前端调用（无需图像生成）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { masterId?: string } | null;
  const masterId = body?.masterId?.trim();
  if (!masterId) return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });

  const { db, userId } = bootstrap();
  try {
    const sprite = await autoMapSpriteForMaster(db, userId, masterId);
    return NextResponse.json({ ok: true, sprite });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成形象失败" },
      { status: 400 },
    );
  }
}
