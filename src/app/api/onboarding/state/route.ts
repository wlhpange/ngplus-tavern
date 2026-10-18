import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { bootstrap } from "@/server/bootstrap";
import { isOnboarded } from "@/server/masters";
import { masters, saves } from "@/server/db/schema";

export const dynamic = "force-dynamic";

/**
 * 冷启动状态（M5 三幕：推门 → 选会长 → 进对话）。
 *
 * 前端根路由据此决定跳转：
 * - onboarded=false 且未选定会长 → /gate（推门）
 * - onboarded=false 但已选定会长 → /masters（第二幕：选人）后进对话
 * - onboarded=true → /（对话主界面）
 *
 * DESIGN-DECISION: 默认存档在种子阶段已指向薇拉（零配置兜底，persona §5）。
 * 因此"已选定会长"不能只看 active_master_id 非空（那永远为真），
 * 而要看 master_history 里是否存在"用户主动选择"的痕迹：
 * 推门后进入第二幕即视为"已过第一幕"，用 onboarded_at 与
 * activeMasterId 的组合表达三幕进度。
 */
export async function GET() {
  const { db, userId } = bootstrap();
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) {
    return NextResponse.json({ error: "存档缺失" }, { status: 500 });
  }
  let masterName: string | null = null;
  if (save.activeMasterId) {
    const m = db
      .select({ name: masters.name })
      .from(masters)
      .where(eq(masters.id, save.activeMasterId))
      .get();
    masterName = m?.name ?? null;
  }
  return NextResponse.json({
    onboarded: isOnboarded(db, userId),
    activeMasterId: save.activeMasterId,
    masterName,
    /** 第一幕（推门）是否已完成：进入过第二幕就会在 localStorage 留痕，
     *  服务端只给出"是否需要推门"的判据，具体由前端 localStorage 决定。 */
    needsGate: !isOnboarded(db, userId),
  });
}
