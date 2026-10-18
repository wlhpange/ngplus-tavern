import { NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { isOnboarded, markOnboarded } from "@/server/masters";

export const dynamic = "force-dynamic";

/** 标记冷启动完成（第二幕结束、用户站到会长面前时由前端调用）。幂等。 */
export async function POST() {
  const { db, userId } = bootstrap();
  const changed = markOnboarded(db, userId);
  return NextResponse.json({ ok: true, changed, onboarded: isOnboarded(db, userId) });
}
