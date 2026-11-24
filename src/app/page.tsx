import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { bootstrap } from "@/server/bootstrap";
import { isOnboarded } from "@/server/masters";
import { loadHomeData } from "@/server/homeData";
import Home from "./chat-home";

export const dynamic = "force-dynamic";

/**
 * 根路由：冷启动守门（M5 三幕）。
 * - 未完成冷启动 → /gate（第一幕 · 推门）
 * - 已完成 → 对话主界面
 *
 * 首屏直接服务端组装时间线传给客户端，避免水合后再请求一次 /api/chat：
 * 用户打开页面立刻看到最近对话，而不是骨架屏。
 * 当前模式存在 cookie（ngplus_mode），服务端据此渲染任务或聊天流。
 */
export default function Page() {
  const { db, userId } = bootstrap();
  if (!isOnboarded(db, userId)) {
    redirect("/gate");
  }
  const mode = cookies().get("ngplus_mode")?.value === "chat" ? "chat" : "quest";
  const data = loadHomeData(db, userId, { mode });
  return <Home initial={{ mode, data }} />;
}
