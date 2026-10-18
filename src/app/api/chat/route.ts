import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { runConversation, runChatConversation, ensureChatGreeting, chatGreetingOptions, cycleChatGreeting } from "@/server/llm/conversation";
import { MissingApiKeyError } from "@/server/llm/client";
import {
  markPending,
  clearPending,
  pendingKey,
  isPending,
} from "@/server/llm/pending";
import { modelFromDb } from "@/server/modelConfig";
import {
  chatWindowStart,
  hasRecordsBefore,
  queryRecords,
  type ChatMode,
  type RecordItem,
} from "@/server/records";
import {
  ensureActiveSession,
  listSessions,
  getSession,
} from "@/server/chatSessions";
import { assetUrl, sceneFilename } from "@/server/assets";
import { getSceneJob } from "@/server/image/jobs";
import { getImageConfig } from "@/server/image/config";
import { getChatMasterId } from "@/server/masters";
import { saves, masters } from "@/server/db/schema";
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

/**
 * 对话主界面数据：最近 3 个自然日的消息与结算卡片。
 * ?mode=quest|chat 切换两条隔离的流（默认 quest）。
 * P10 聊天模式：?sessionId 选会话；省略时自动取/建当前会长的活跃会话。
 */
export async function GET(req: NextRequest) {
  const { db, userId } = bootstrap();
  const mode = parseMode(req.nextUrl.searchParams.get("mode"));

  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  // P12：聊天模式用「聊天会长」（未设置则跟随任务会长）；任务模式用任务会长
  const currentMasterId =
    mode === "chat" ? getChatMasterId(db, userId) : (save?.activeMasterId ?? null);
  let currentMasterName = "会长";
  let currentMasterAvatar: string | null = null;
  let currentMasterSprite: string | null = null;
  if (currentMasterId) {
    const master = db
      .select()
      .from(masters)
      .where(eq(masters.id, currentMasterId))
      .get();
    if (master) {
      currentMasterName = master.name;
      currentMasterAvatar = master.avatar ?? null;
      currentMasterSprite = master.sprite ?? null;
    }
  }

  // P10 聊天模式：确定会话（指定 → 校验归属；否则取/建活跃会话）
  let sessionId: string | null = null;
  let sessions: ReturnType<typeof listSessions> = [];
  if (mode === "chat" && currentMasterId) {
    const requested = req.nextUrl.searchParams.get("sessionId");
    const wanted = requested ? getSession(db, userId, requested) : null;
    sessionId =
      wanted && wanted.masterId === currentMasterId
        ? wanted.id
        : ensureActiveSession(db, userId, currentMasterId);
    ensureChatGreeting(db, userId, sessionId);
    sessions = listSessions(db, userId, currentMasterId);
  }

  const windowStart = chatWindowStart();
  // 聊天模式：按会话取历史（不受三天窗口限制，否则老会话点进去一片空白），
  // 支持 before 游标向前翻页；任务模式仍只看最近三个自然日。
  const beforeParam = Number(req.nextUrl.searchParams.get("before"));
  const chatBefore = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : null;
  const CHAT_PAGE = 200;
  const { items, hasMore, nextBefore } = queryRecords(db, userId, {
    ...(mode === "chat"
      ? { before: chatBefore, limit: CHAT_PAGE }
      : { since: windowStart, limit: 300 }),
    mode,
    sessionId,
    // 任务流：只看当前会长的主线；结算卡片仍全局（本查询的 settlement 分支不过滤）
    masterId: mode === "quest" ? (save?.activeMasterId ?? null) : null,
  });
  // 主界面按时间正序渲染
  items.reverse();

  const messages = items.filter(
    (it): it is Extract<RecordItem, { type: "message" }> => it.type === "message",
  );
  const settlements = items.filter(
    (it): it is Extract<RecordItem, { type: "settlement" }> => it.type === "settlement",
  );

  return NextResponse.json({
    mode,
    masterName: currentMasterName,
    // 本地生图开关（关闭时前台不显示「给这一幕配图」按钮）
    imageEnabled: getImageConfig(db).enabled,
    masterAvatar: assetUrl("avatar", currentMasterAvatar),
    masterSprite: (() => {
      if (!currentMasterSprite) return null;
      try {
        return JSON.parse(currentMasterSprite);
      } catch {
        return null;
      }
    })(),
    background: assetUrl("background", sessionId ? getSession(db, userId, sessionId)?.scene : null),
    // P12：聊天模式返回聊天会长（前端开场白编辑等用），任务模式返回任务会长
    activeMasterId: currentMasterId,
    windowStart,
    // 任务模式用三天窗口判定是否有更早内容（走 /records 归档）；
    // 聊天模式用会话内分页游标（下一页的 before，null = 没有更早的了）。
    hasEarlier:
      mode === "chat"
        ? hasMore
        : hasRecordsBefore(
            db,
            userId,
            windowStart,
            mode,
            sessionId,
            save?.activeMasterId ?? null,
          ),
    nextBefore: mode === "chat" ? nextBefore : null,
    messages: messages.map((m) => {
      const job = getSceneJob(m.id, db);
      const generating = !!job && (job.status === "queued" || job.status === "running");
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        sender: m.sender,
        createdAt: m.createdAt,
        // 本地生图：该消息若已配图则给出 URL（文件在 data/scenes/<id>.png）
        image: assetUrl("scene", sceneFilename(m.id)),
        // 后台是否正在为该消息生成配图（前台刷新/重进后据此恢复「正在作画」）
        generating,
        generatingSince: generating ? job!.startedAt : undefined,
      };
    }),
    settlements: settlements.map((s) => s.settlement),
    // P10 聊天模式：会话列表 + 当前会话 + 开场白候选
    sessionId,
    sessions,
    greeting: mode === "chat" && sessionId ? chatGreetingOptions(db, userId, sessionId) : undefined,
    // 该 mode/会话是否仍有生成在途（切页回来恢复「正在回复」用）
    // 作用域与 POST 一致：聊天=会话，任务=当前会长
    pending: isPending(
      pendingKey(userId, mode, mode === "chat" ? sessionId : (save?.activeMasterId ?? null)),
      db,
    ),
  });
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
