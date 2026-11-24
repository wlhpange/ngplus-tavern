import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { runConversation, runChatConversation, cycleChatGreeting } from "@/server/llm/conversation";
import { MissingApiKeyError } from "@/server/llm/client";
import {
  markPending,
  clearPending,
  pendingKey,
} from "@/server/llm/pending";
import { modelFromDb } from "@/server/modelConfig";
import type { ChatMode } from "@/server/records";
import { ensureActiveSession, getSession } from "@/server/chatSessions";
import { getChatMasterId } from "@/server/masters";
import { loadHomeData } from "@/server/homeData";
import { saves } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** SSE 响应头：禁用缓冲，token 逐条下发到前端 */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** 解析对话模式参数（默认任务管线；未知值一律按任务处理） */
function parseMode(value: unknown): ChatMode {
  return value === "chat" ? "chat" : "quest";
}

/** 当前活跃会长 id（聊天会话归属用） */
function activeMasterId(
  db: ReturnType<typeof bootstrap>["db"],
  userId: string,
): string | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  return save?.activeMasterId ?? null;
}

/** 解析查询参数里的正整数时间戳；非法值返回 null */
function positive(v: string | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 对话主界面数据：最近 3 个自然日的消息与结算卡片。
 * ?mode=quest|chat 切换两条隔离的流（默认 quest）。
 * P10 聊天模式：?sessionId 选会话；省略时自动取/建当前会长的活跃会话。
 * ?since=<ms> 为增量轮询；组装逻辑见 homeData.ts（首屏 SSR 复用同一份）。
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const sp = req.nextUrl.searchParams;
  const data = loadHomeData(db, userId, {
    mode: parseMode(sp.get("mode")),
    sessionId: sp.get("sessionId"),
    before: positive(sp.get("before")),
    since: positive(sp.get("since")),
  });
  return NextResponse.json(data);
}

/**
 * 发送消息：流式返回（SSE）。
 * 事件：{"type":"delta","text":…} / {"type":"reset"} /
 *       {"type":"done",…结构化结果} / {"type":"error","error":…,"code":?}
 * cycleGreeting 仍走一次性 JSON。
 */
export async function POST(req: NextRequest) {
  let message: string;
  let mode: ChatMode;
  let action: string | undefined;
  let sessionId: string | undefined;
  try {
    const body = (await req.json()) as {
      message?: unknown;
      mode?: unknown;
      action?: unknown;
      sessionId?: unknown;
    };
    message = typeof body.message === "string" ? body.message.trim() : "";
    mode = parseMode(body.mode);
    action = typeof body.action === "string" ? body.action : undefined;
    sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { db, userId } = bootstrap();

  // P9 聊天模式：换一条开场白（swipe）——不需要 message，保持 JSON
  if (mode === "chat" && action === "cycleGreeting") {
    if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
    const r = cycleChatGreeting(db, userId, sessionId);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
    return NextResponse.json({ mode, ...r });
  }

  if (!message) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  // 聊天模式：确定会话（校验归属；缺失/不属于聊天会长 → 取活跃会话）
  let chatSessionId: string | null = null;
  if (mode === "chat") {
    const masterId = getChatMasterId(db, userId);
    let sid = sessionId;
    if (sid) {
      const s = getSession(db, userId, sid);
      if (!s || s.masterId !== masterId) sid = undefined;
    }
    if (!sid && masterId) sid = ensureActiveSession(db, userId, masterId);
    if (!sid) {
      return NextResponse.json({ error: "还没有会长，先去选一位" }, { status: 400 });
    }
    chatSessionId = sid;
  }

  const encoder = new TextEncoder();
  const pendingScope = mode === "chat" ? chatSessionId : activeMasterId(db, userId);
  const pendingK = pendingKey(userId, mode, pendingScope);
  // 登记在途：切页回来后前端仍能恢复「正在回复」并轮询结果
  markPending(pendingK, db);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        if (mode === "chat") {
          const result = await runChatConversation(db, userId, message, chatSessionId!, {
            model: modelFromDb(db),
            onEvent: send,
          });
          send({
            type: "done",
            mode,
            sessionId: chatSessionId,
            reply: result.replyText,
            userMessageId: result.userMessageId,
            masterMessageId: result.masterMessageId,
          });
        } else {
          const result = await runConversation(db, userId, message, {
            model: modelFromDb(db),
            onEvent: send,
          });
          send({
            type: "done",
            mode,
            reply: result.replyText,
            userMessageId: result.userMessageId,
            masterMessageId: result.masterMessageId,
            toolSummaries: result.toolSummaries,
            stateChanged: result.stateChanged,
            settlementNotices: result.settlementNotices,
            reminderNotices: result.reminderNotices,
            settlements: result.settlements,
            ceremony: result.ceremony ?? null,
          });
        }
      } catch (e) {
        if (e instanceof MissingApiKeyError) {
          send({ type: "error", error: e.message, code: "NO_API_KEY" });
        } else {
          console.error(mode === "chat" ? "[/api/chat:chat]" : "[/api/chat]", e);
          send({
            type: "error",
            error: e instanceof Error ? e.message : "会长那边出了点状况，请稍后再试。",
          });
        }
      } finally {
        clearPending(pendingK, db);
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    },
    cancel() {
      // 客户端断开（切页 / 刷新 / 流被取消）**不清除**在途标记：
      // 服务端那次生成还在继续跑，标记要留着，切回来才能恢复「正在回复」。
      // 真正结束时由 finally 清除；异常残留由 STALE_MS 兜底。
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
