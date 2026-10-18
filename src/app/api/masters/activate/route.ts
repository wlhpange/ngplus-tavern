import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { switchMaster, getSaveState } from "@/server/masters";

export const dynamic = "force-dynamic";

/**
 * 激活/切换会长（首次选择与热切换共用此入口）。
 * V2.0：取消 LLM 告别信——切换即时完成，不再等模型（告别信功能判定为冗余）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    masterId?: string;
  } | null;
  if (!body?.masterId) {
    return NextResponse.json({ error: "缺少 masterId" }, { status: 400 });
  }

  const { db, userId } = bootstrap();
  try {
    const result = await switchMaster(db, userId, body.masterId);
    const saveState = getSaveState(db, userId);
    return NextResponse.json({
      ...result,
      intimacyLabel: saveState?.intimacyLabel ?? "初识",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "切换失败" },
      { status: 400 },
    );
  }
}
