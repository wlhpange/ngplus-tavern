import { redirect } from "next/navigation";
import { bootstrap } from "@/server/bootstrap";
import { isOnboarded } from "@/server/masters";
import Home from "./chat-home";

export const dynamic = "force-dynamic";

/**
 * 根路由：冷启动守门（M5 三幕）。
 * - 未完成冷启动 → /gate（第一幕 · 推门）
 * - 已完成 → 对话主界面
 * 守门在服务端做，保证新用户第一眼看到的是门，不是聊天框。
 */
export default function Page() {
  const { db, userId } = bootstrap();
  if (!isOnboarded(db, userId)) {
    redirect("/gate");
  }
  return <Home />;
}
