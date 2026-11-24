"use client";

/**
 * 对话主界面（V2.0 时间线版）
 * - 消息与结算卡片合并成一条时间线（结算数据来自 settlement_log）
 * - 历史分页：默认最近 50 条，「查看更早的对话」按页加载并保持滚动位置
 * - 日期分隔（今天 / 昨天 / M月D日）
 * - 智能滚动：只在用户接近底部时自动滚，读历史不强拉
 * - 消息归属：每条会长消息显示正确的会长名（换人后不串）
 * - 仪式事件：升级 / 晋段由 CeremonyOverlay 呈现
 * - 发送失败：撤掉本地乐观消息、退回输入框，可直接重发
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import Avatar from "@/components/Avatar";
import ChatText from "@/components/ChatText";
import ConfirmDialog from "@/components/ConfirmDialog";
import PixelPet from "@/components/PixelPet";
import type { PetDescriptor } from "@/lib/petCatalog";
import { detectFace, type FaceId } from "@/lib/mood";
import { petEnabled } from "@/lib/pet";
import GreetingEditor from "@/components/GreetingEditor";
import ImageLightbox from "@/components/ImageLightbox";
import PromptDialog from "@/components/PromptDialog";
import CeremonyOverlay, { type CeremonyEvent } from "@/components/CeremonyOverlay";
import SettlementCard from "@/components/SettlementCard";
import MessageRow from "@/components/chat/MessageRow";
import Composer from "@/components/chat/Composer";
import type {
  ApiMessage,
  ChatResponse,
  ChatSessionSummary,
  HistoryResponse,
  Mode,
  Notice,
  TimelineItem,
} from "@/components/chat/types";
import {
  dayKey,
  dayLabel,
  itemKey,
  itemTime,
  mergeItems,
  messageOf,
} from "@/components/chat/timeline";

// SSR 期间不执行 layout effect（客户端首帧定位到底部，无滑动动画）
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 记住上次停留的模式，避免每次点「对话」都回到任务页 */
const MODE_STORAGE_KEY = "ngplus.chat.mode";
/** 时间线默认渲染条数（长列表优化）；「展开更早」每次 +60 */
const RENDER_PAGE = 60;
const NOTICE_TTL = 30_000;

export default function Home({
  initial,
}: {
  /** 服务端首屏数据（见 app/page.tsx）；缺省时退化为纯客户端加载 */
  initial?: { mode: Mode; data: HistoryResponse };
}) {
  const initialData = initial?.data;
  const initialGenerating = initialData?.messages?.find((m) => m.generating);
  const [masterName, setMasterName] = useState(initialData?.masterName ?? "会长");
  /** 会长头像 URL（来自卡 PNG / 上传）；null 回落名字首字 */
  const [masterAvatar, setMasterAvatar] = useState<string | null>(
    initialData?.masterAvatar ?? null,
  );
  /** 会长像素小人形象参数；null = 不显示 */
  const [masterSprite, setMasterSprite] = useState<PetDescriptor | null>(
    (initialData?.masterSprite as PetDescriptor | null | undefined) ?? null,
  );
  /** 点小人互动：短暂播放 emote */
  const [petReact, setPetReact] = useState(false);
  /** 对话页是否显示像素小人（本机偏好，设置页可关） */
  const [showPet, setShowPet] = useState(true);
  /** 本轮识别到的情绪表情（临时覆盖脸层；null = 用设定里的表情） */
  const [moodFace, setMoodFace] = useState<FaceId | null>(null);
  const moodTimer = useRef(0);
  /** 当前聊天会话背景 URL（仅聊天模式生效） */
  const [background, setBackground] = useState<string | null>(
    initialData?.background ?? null,
  );
  /** 背景设置面板开合 / 上传中 */
  const [bgPanelOpen, setBgPanelOpen] = useState(false);
  const [bgUploading, setBgUploading] = useState(false);
  /** P0 对话模式：quest=任务管线，chat=聊天（酒馆）管线 */
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "quest");
  /** 模式是否已从本机偏好恢复（恢复前先不拉时间线，避免先闪任务页） */
  const [modeReady, setModeReady] = useState(Boolean(initial));
  /** null = 首次加载中；有服务端首屏数据时直接渲染 */
  const [items, setItems] = useState<TimelineItem[] | null>(() => {
    if (!initialData) return null;
    const msgs: TimelineItem[] = (initialData.messages ?? []).map((message) => ({
      type: "message",
      message,
    }));
    const sets: TimelineItem[] = (initialData.settlements ?? []).map((settlement) => ({
      type: "settlement",
      settlement,
    }));
    return mergeItems(msgs, sets);
  });
  const [hasEarlier, setHasEarlier] = useState(Boolean(initialData?.hasEarlier));
  /** 聊天模式向前翻页游标（加载更早的对话用；null = 到头） */
  const [chatNextBefore, setChatNextBefore] = useState<number | null>(
    initialData?.nextBefore ?? null,
  );
  const [chatLoadingEarlier, setChatLoadingEarlier] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sending, setSending] = useState(false);
  /** 流式生成中的临时正文（SSE delta 累积；done 后并入时间线） */
  const [streamingReply, setStreamingReply] = useState("");
  /** 本次发送归属的 mode/会话：把「正在回复」限定在原模式，避免切模式串泡 */
  const [sendingCtx, setSendingCtx] = useState<{ mode: Mode; sessionId: string | null } | null>(null);
  /** 长列表优化：默认只渲染最近 N 条，更早的折叠（点「展开更早」加量） */
  const [visibleCount, setVisibleCount] = useState(60);
  /** 滚离底部时浮出「回到最新」 */
  const [showJump, setShowJump] = useState(false);
  /** 展开更早前记录 scrollHeight，渲染后按差值补偿，避免内容跳动 */
  const expandAnchorRef = useRef<number | null>(null);
  /** 服务端仍在生成（本页发起之外的回合，如切页回来后）：显示「正在回复」并轮询 */
  const [serverPending, setServerPending] = useState(Boolean(initialData?.pending));
  const [error, setError] = useState<string | null>(null);
  /** 本地生图：正在为哪条消息作画（messageId）；null = 空闲 */
  const [sceneBusy, setSceneBusy] = useState<string | null>(
    initialGenerating?.id ?? null,
  );
  const [sceneError, setSceneError] = useState<string | null>(null);
  /** 本地生图是否开启（关闭则隐藏「给这一幕配图」按钮） */
  const [imageEnabled, setImageEnabled] = useState(Boolean(initialData?.imageEnabled));
  /** 点开预览的大图 URL；null = 关闭 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** 生图开始时间戳 + 已用秒数（作画中每秒刷新，给进度感） */
  const [sceneStartedAt, setSceneStartedAt] = useState<number | null>(
    initialGenerating?.generatingSince ?? (initialGenerating ? Date.now() : null),
  );
  /** 待确认删除的消息 */
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; preview: string } | null>(null);
  /** P10 会话改名 / 删除：应用内弹窗（替代原生 prompt/confirm） */
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ceremony, setCeremony] = useState<CeremonyEvent | null>(null);
  /** P9 聊天模式：开场白候选与当前下标 */
  const [greeting, setGreeting] = useState<{ greetings: string[]; currentIndex: number } | null>(
    initialData?.greeting ?? null,
  );
  const [greetingEditorOpen, setGreetingEditorOpen] = useState(false);
  const [activeMasterId, setActiveMasterId] = useState<string | null>(
    initialData?.activeMasterId ?? null,
  );
  /** 本任期用户是否已开口（开口后不再允许换开场白） */
  const [userSpoke, setUserSpoke] = useState(
    (initialData?.messages ?? []).some((m) => m.role === "user"),
  );
  /** P10 聊天会话 */
  const [sessionId, setSessionId] = useState<string | null>(initialData?.sessionId ?? null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>(initialData?.sessions ?? []);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  /** 首屏是否已瞬时定位到底部（定位前不做平滑滚动） */
  const initialPositioned = useRef(false);
  /** 服务端首屏数据只跳过一次请求；之后切模式/会话照常拉取 */
  const initialConsumed = useRef(false);
  /** 当前 mode/会话的镜像：供在途 send() 完成时判断是否已切走 */
  const modeRef = useRef<Mode>("quest");
  const sessionRef = useRef<string | null>(null);
  /** 时间线的镜像：loadTimeline 是空依赖 useCallback，增量轮询需要读到最新 items */
  const itemsRef = useRef<TimelineItem[] | null>(null);
  modeRef.current = mode;
  sessionRef.current = sessionId;
  itemsRef.current = items;
  /** 本轮在途是否属于「当前 mode/会话」——切模式后不在别的模式里显示点 */
  const sendingHere =
    sending && sendingCtx?.mode === mode && sendingCtx?.sessionId === sessionId;

  const loadTimeline = useCallback(
    (m: Mode, sessId?: string | null, opts?: { quiet?: boolean }) => {
      // quiet：轮询刷新用。不清空当前时间线（避免闪烁 / 滚动回顶），只替换为服务端真值。
      if (!opts?.quiet) {
        setItems(null);
        setHasEarlier(false);
        setChatNextBefore(null);
        // 切模式/会话时重新贴底：先把「已定位」标记复位
        initialPositioned.current = false;
        isNearBottom.current = true;
        // 切模式/会话：重置长列表折叠量与「回到最新」按钮
        setVisibleCount(RENDER_PAGE);
        setShowJump(false);
      }
      const q = new URLSearchParams({ mode: m });
      if (m === "chat" && sessId) q.set("sessionId", sessId);
      // 静默刷新且仍停在同一条时间线上时走增量：只拉 since 之后落库的内容。
      // 切换模式/会话、翻页、首次加载仍取全量。
      const canIncremental =
        Boolean(opts?.quiet) &&
        modeRef.current === m &&
        (sessId ?? null) === sessionRef.current &&
        (itemsRef.current?.length ?? 0) > 0;
      const since = canIncremental
        ? Math.max(...(itemsRef.current ?? []).map(itemTime))
        : null;
      if (since != null) q.set("since", String(since));
      fetch(`/api/chat?${q.toString()}`)
        .then((r) => r.json())
        .then((d: HistoryResponse) => {
          if (d.masterName) setMasterName(d.masterName);
          setMasterAvatar(d.masterAvatar ?? null);
          setMasterSprite((d.masterSprite as PetDescriptor | null) ?? null);
          setBackground(d.background ?? null);
          setImageEnabled(Boolean(d.imageEnabled));
          const msgs: TimelineItem[] = (d.messages ?? []).map((msg) => ({
            type: "message",
            message: msg,
          }));
          const sets: TimelineItem[] = (d.settlements ?? []).map((s) => ({
            type: "settlement",
            settlement: s,
          }));
          // 静默刷新（轮询/回到标签）要与已加载的旧页合并，否则翻过的历史会丢。
          // 增量响应只含新内容，同样按 id 去重追加。
          setItems((prev) =>
            opts?.quiet ? mergeItems(prev ?? [], mergeItems(msgs, sets)) : mergeItems(msgs, sets),
          );
          // 增量响应省略了静态字段：只在字段存在时更新，避免把会话列表/开场白清空
          if (d.hasEarlier !== undefined) setHasEarlier(Boolean(d.hasEarlier));
          if (!opts?.quiet) setChatNextBefore(d.nextBefore ?? null);
          // 服务端仍在为某条消息生成配图：恢复「正在作画」，交给轮询接手
          const gen = (d.messages ?? []).find((m2) => m2.generating);
          if (gen) {
            setSceneBusy(gen.id);
            setSceneStartedAt(gen.generatingSince ?? Date.now());
          }
          if (d.greeting !== undefined) setGreeting(d.greeting ?? null);
          if (d.activeMasterId !== undefined) setActiveMasterId(d.activeMasterId ?? null);
          if (!since) setUserSpoke((d.messages ?? []).some((m2) => m2.role === "user"));
          if (d.sessionId !== undefined) setSessionId(d.sessionId ?? null);
          if (d.sessions) setSessions(d.sessions);
          setServerPending(Boolean(d.pending));
        })
        .catch(() => {
          if (opts?.quiet) return; // 轮询失败保留现状，等下一次
          setItems([]);
          setError("没能翻开协会的登记簿，刷新一下再试。");
        });
    },
    [],
  );

  // 恢复上次停留的模式（任务/聊天）：点「对话」回来仍停在原处，不用每次手动切
  useEffect(() => {
    const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "chat" || saved === "quest") setMode(saved);
    setModeReady(true);
  }, []);

  // 对话页像素小人显示开关（本机偏好）
  useEffect(() => {
    setShowPet(petEnabled());
  }, []);

  useEffect(() => {
    if (!modeReady) return;
    if (initial && !initialConsumed.current && mode === initial.mode) {
      initialConsumed.current = true;
      return;
    }
    loadTimeline(mode);
  }, [mode, modeReady, loadTimeline, initial]);

  // 服务端仍有生成在途（典型场景：发完消息切到别的页面再回来）：显示「正在回复」
  // 并每 2.5s 静默刷新，直到回复落库、pending 变回 false。
  useEffect(() => {
    if (!serverPending || sendingHere) return;
    const timer = window.setInterval(() => {
      loadTimeline(mode, mode === "chat" ? sessionId : undefined, { quiet: true });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [serverPending, sendingHere, mode, sessionId, loadTimeline]);

  // 切回浏览器标签 / 窗口重新可见时重新拉一次：恢复「正在回复」+ 补齐期间落库的消息。
  // （后台标签会节流定时器，仅靠轮询可能停更。）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadTimeline(mode, mode === "chat" ? sessionId : undefined, { quiet: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [mode, sessionId, loadTimeline]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    window.localStorage.setItem(MODE_STORAGE_KEY, next);
    // 服务端首屏据此渲染正确模式（localStorage 只在客户端可读）
    document.cookie = `ngplus_mode=${next}; path=/; max-age=31536000; samesite=lax`;
    setNotices([]);
    setError(null);
    setCeremony(null);
    setMode(next);
    // 不主动 focus：手机上会立刻弹输入法，用户想自己点输入栏再打字
  }

  /** P9 换一条开场白（swipe）：只在用户开口前可用 */
  async function cycleGreeting() {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "chat", action: "cycleGreeting", sessionId }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "换不了开场白。");
        return;
      }
      loadTimeline("chat", sessionId);
    } catch {
      setError("网络不通，换不了开场白。");
    }
  }

  /** P10 会话操作：新建 / 切换 / 改名 / 删除 */
  async function sessionAction(action: string, extra: Record<string, unknown> = {}) {
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "操作失败。");
        return;
      }
      setSessionMenuOpen(false);
      const next = d.sessionId ?? d.nextSessionId ?? sessionId;
      loadTimeline("chat", next);
    } catch {
      setError("网络不通，操作失败。");
    }
  }

  function newSession() {
    sessionAction("create", { title: `新的对话` });
  }

  function switchSession(id: string) {
    setSessionMenuOpen(false);
    loadTimeline("chat", id);
  }

  function renameSession(id: string, current: string) {
    setRenameTarget({ id, title: current });
  }

  function deleteSession(id: string, title: string) {
    setSessionDeleteTarget({ id, title });
  }
  /** 上传并设置当前会话背景；file = null 表示清除背景 */
  async function setBackgroundImage(file: File | null) {
    if (!sessionId || bgUploading) return;
    setBgUploading(true);
    setError(null);
    try {
      let scene: string | null = null;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const up = await fetch("/api/assets/upload?kind=background", {
          method: "POST",
          body: form,
        });
        const ud = await up.json();
        if (!up.ok || ud.error) {
          setError(ud.error ?? "背景上传失败。");
          return;
        }
        scene = ud.file as string;
      }
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setBackground", sessionId, scene }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "背景设置失败。");
        return;
      }
      setBgPanelOpen(false);
      loadTimeline("chat", sessionId);
    } catch {
      setError("网络不通，背景没换成。");
    } finally {
      setBgUploading(false);
    }
  }

  // 首屏定位：瞬时贴底（浏览器绘制前完成，用户看不到滑动过程）
  useIsoLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || items === null || initialPositioned.current) return;
    el.scrollTop = el.scrollHeight;
    initialPositioned.current = true;
    // 消息里有长段落后字体/换行在下一帧才定型：再贴一次底，确保停在最新一条
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [items]);

  // 之后只在新内容到达时平滑跟随（且用户接近底部）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !initialPositioned.current || !isNearBottom.current) return;
    // 流式逐字追加时用瞬时滚动，避免一堆 smooth 动画排队卡顿
    el.scrollTo({ top: el.scrollHeight, behavior: streamingReply ? "auto" : "smooth" });
  }, [items, sending, streamingReply]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.current = gap < 80;
    setShowJump(gap > 240);
  }

  /** 「回到最新」：瞬时贴底并复位跟随状态 */
  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  /** 展开更早：先记 scrollHeight，渲染后补偿，保持当前视觉位置不乱跳 */
  function expandEarlier() {
    const el = scrollRef.current;
    expandAnchorRef.current = el?.scrollHeight ?? null;
    setVisibleCount((c) => c + RENDER_PAGE);
  }

  /**
   * 聊天模式：按游标向前加载更早的一页会话消息（服务端分页）。
   * 新消息拼在顶部，渲染后按高度差补偿，保持用户当前看到的位置。
   */
  async function loadEarlierChat() {
    if (!sessionId || chatNextBefore == null || chatLoadingEarlier) return;
    const el = scrollRef.current;
    const beforeHeight = el?.scrollHeight ?? 0;
    const beforeTop = el?.scrollTop ?? 0;
    setChatLoadingEarlier(true);
    try {
      const q = new URLSearchParams({
        mode: "chat",
        sessionId,
        before: String(chatNextBefore),
      });
      const r = await fetch(`/api/chat?${q.toString()}`);
      const d = (await r.json()) as HistoryResponse;
      const older: TimelineItem[] = (d.messages ?? []).map((msg) => ({
        type: "message",
        message: msg,
      }));
      setItems((prev) => mergeItems(older, prev ?? []));
      setHasEarlier(Boolean(d.hasEarlier));
      setChatNextBefore(d.nextBefore ?? null);
      // 一并渲染新载入的旧消息，避免它们又被折叠起来
      setVisibleCount((c) => c + older.length);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight);
      });
    } catch {
      setError("网络不通，没能翻到更早的记录。");
    } finally {
      setChatLoadingEarlier(false);
    }
  }

  useIsoLayoutEffect(() => {
    const el = scrollRef.current;
    const before = expandAnchorRef.current;
    if (!el || before == null) return;
    expandAnchorRef.current = null;
    el.scrollTop += el.scrollHeight - before;
  }, [visibleCount]);

  // 通知条 30s 自动过期（只剩对账提醒等非结算提示）
  useEffect(() => {
    if (!notices.length) return;
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - NOTICE_TTL;
      setNotices((n) => n.filter((x) => x.at > cutoff));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [notices]);

  // 后台配图轮询：sceneBusy 有值就每 3 秒查一次，完成/失败才停。
  // 手机锁屏 / 切页造成的网络中断不会终止它——恢复后继续查，图已落盘就能拿到。
  useEffect(() => {
    if (!sceneBusy) return;
    const messageId = sceneBusy;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/chat/image?messageId=${encodeURIComponent(messageId)}`);
        const d = (await res.json().catch(() => ({}))) as {
          status?: string;
          url?: string;
          error?: string;
        };
        if (stopped) return;
        if (d.url) {
          setItems((prev) =>
            (prev ?? []).map((it) =>
              it.type === "message" && it.message.id === messageId
                ? { ...it, message: { ...it.message, image: d.url, generating: false } }
                : it,
            ),
          );
          setSceneBusy(null);
          setSceneStartedAt(null);
          return;
        }
        if (d.status === "error") {
          setSceneError(d.error ?? "配图失败。");
          setSceneBusy(null);
          setSceneStartedAt(null);
          return;
        }
        if (d.status === "idle") {
          // 任务已不在（例如服务重启过）：收尾，让按钮恢复
          setSceneBusy(null);
          setSceneStartedAt(null);
        }
      } catch {
        /* 网络抖动：保持轮询，等恢复 */
      }
    };
    const timer = window.setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [sceneBusy]);

  const addNotices = useCallback((texts: string[]) => {
    const now = Date.now();
    setNotices((n) => [...n, ...texts.map((text) => ({ text, at: now }))]);
  }, []);

  /** 本地生图：为某条会长消息生成「此刻」的情景图（异步，好了挂到该消息上） */
  /** 点击配图：启动后台任务（立即返回），随后由轮询把结果补上 */
  async function generateScene(messageId: string) {
    if (sceneBusy) return;
    setSceneError(null);
    try {
      const res = await fetch("/api/chat/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        startedAt?: number;
        error?: string;
      };
      if (!res.ok || !d.ok) {
        setSceneError(d.error ?? "配图失败。");
        return;
      }
      setSceneBusy(messageId);
      setSceneStartedAt(d.startedAt ?? Date.now());
    } catch {
      setSceneError("网络不通，没能启动配图，请重试。");
    }
  }

  /** 停止正在进行的配图：通知后端 kill 生成进程，并复位前台状态 */
  async function stopScene() {
    const id = sceneBusy;
    if (!id) return;
    setSceneBusy(null);
    setSceneStartedAt(null);
    try {
      await fetch(`/api/chat/image?messageId=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* 停不到也无妨：前台已复位，后台进程随后自己结束 */
    }
  }

  // MessageRow 是 memo 组件：回调必须稳定，否则每次渲染都会重新渲染历史消息。
  // 生图/停止函数依赖当前 state（sceneBusy），用 ref 转发最新实现。
  const generateSceneRef = useRef(generateScene);
  const stopSceneRef = useRef(stopScene);
  generateSceneRef.current = generateScene;
  stopSceneRef.current = stopScene;
  const handleDeleteMessage = useCallback((msg: ApiMessage) => {
    setDeleteTarget({ id: msg.id, preview: msg.content });
  }, []);
  const handleGenerateScene = useCallback((messageId: string) => {
    void generateSceneRef.current(messageId);
  }, []);
  const handleStopScene = useCallback(() => {
    void stopSceneRef.current();
  }, []);
  const handleOpenImage = useCallback((url: string) => setLightbox(url), []);

  /** 删除单条消息：本地未落库的乐观消息只移除；已落库的走接口并连带删配图 */
  async function confirmDelete() {
    const t = deleteTarget;
    if (!t) return;
    setDeleting(true);
    try {
      if (t.id.startsWith("local_")) {
        setItems((prev) => (prev ?? []).filter((it) => itemKey(it) !== t.id));
        setDeleteTarget(null);
        return;
      }
      const res = await fetch(`/api/chat/messages?id=${encodeURIComponent(t.id)}`, {
        method: "DELETE",
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? "删除失败。");
        return;
      }
      setItems((prev) => (prev ?? []).filter((it) => itemKey(it) !== t.id));
      setDeleteTarget(null);
    } catch {
      setError("网络不通，删除失败。");
    } finally {
      setDeleting(false);
    }
  }

  /** 发送一条消息；返回 false 表示失败（输入框会把文字还回去） */
  async function send(text: string): Promise<boolean> {
    if (!text || sending || serverPending) return false;
    const localId = `local_u_${Date.now()}`;
    const optimistic: TimelineItem = {
      type: "message",
      message: { id: localId, role: "user", content: text, sender: "", createdAt: Date.now() },
    };
    setItems((prev) => mergeItems(prev ?? [], [optimistic]));
    setError(null);
    setSending(true);
    setStreamingReply("");
    setSendingCtx({ mode, sessionId });
    isNearBottom.current = true; // 发消息时强制滚到底
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, mode, sessionId }),
      });

      // 非流式错误（空消息 / 没有会长 / 非法 JSON）：后端此时以 JSON 返回
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "会长那边出了点状况，请稍后再试。");
      }

      // 逐条解析 SSE：delta 累积显示，reset 清掉本轮作废文字（工具调用轮），done 收尾
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneEvent: ChatResponse | null = null;
      let failed: string | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const line = chunk.startsWith("data:") ? chunk.slice(5).trim() : chunk.trim();
          if (!line) continue;
          let evt: { type?: string; text?: string } & Partial<ChatResponse>;
          try {
            evt = JSON.parse(line) as typeof evt;
          } catch {
            continue;
          }
          if (evt.type === "delta" && typeof evt.text === "string") {
            setStreamingReply((s) => s + evt.text);
          } else if (evt.type === "reset") {
            setStreamingReply("");
          } else if (evt.type === "done") {
            doneEvent = evt as ChatResponse;
          } else if (evt.type === "error") {
            failed = evt.error ?? "会长那边出了点状况，请稍后再试。";
          }
        }
      }

      if (failed) throw new Error(failed);
      if (!doneEvent) throw new Error("连接中断了，请再试一次。");

      const data = doneEvent;
      const now = Date.now();
      const additions: TimelineItem[] = [];
      for (const s of data.settlements ?? []) {
        additions.push({ type: "settlement", settlement: s, fresh: true });
      }
      if (data.reply) {
        additions.push({
          type: "message",
          message: {
            // 用服务端落库的真实 id（拿不到才退回本地 id）
            id: data.masterMessageId ?? `local_m_${now}`,
            role: "master",
            content: data.reply,
            sender: masterName,
            createdAt: now,
          },
        });
        if (modeRef.current === mode && sessionRef.current === sessionId) {
          flashMood(detectFace(data.reply));
        }
      }
      // 只有仍停在本轮所属的 mode/会话时才并入当前时间线；
      // 已切走就交给切回时的 loadTimeline 重新拉取（服务端已落库）。
      if (modeRef.current === mode && sessionRef.current === sessionId) {
        setItems((prev) => {
          // 把乐观的用户消息换成服务端真实 id（生图 / 删除需要真实 id）
          const base = (prev ?? []).map((it) =>
            data.userMessageId && it.type === "message" && it.message.id === localId
              ? { ...it, message: { ...it.message, id: data.userMessageId } }
              : it,
          );
          return mergeItems(base, additions);
        });
        const reminders = data.reminderNotices ?? data.settlementNotices ?? [];
        if (reminders.length) {
          addNotices(reminders);
        }
        if (data.ceremony) {
          setCeremony(data.ceremony);
        }
        // 不自动 focus 输入框：手机上会在回复结束时自动弹输入法，用户想打字时自己点
      }
      return true;
    } catch (e) {
      // 失败撤回乐观消息，把内容还给输入框，用户可直接重发
      setItems((prev) => (prev ?? []).filter((it) => itemKey(it) !== localId));
      setError(e instanceof Error && e.message ? e.message : "网络不通，消息没能送到协会。");
      return false;
    } finally {
      setSending(false);
      setSendingCtx(null);
      setStreamingReply("");
    }
  }

  /** 聊天模式有背景时：背景铺满整页，消息泡转半透明，让场景真正透出来 */
  const bgVisible = mode === "chat" && Boolean(background);
  // 样式对象必须稳定：MessageRow 用 memo，浅比较下每次新建对象会让 memo 失效
  const pageStyle = useMemo<React.CSSProperties | undefined>(
    () =>
      bgVisible
        ? {
            backgroundImage: `linear-gradient(color-mix(in oklch, var(--bg) 48%, transparent), color-mix(in oklch, var(--bg) 48%, transparent)), url(${background})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }
        : undefined,
    [bgVisible, background],
  );
  const bubbleStyle = useMemo<React.CSSProperties | undefined>(
    () =>
      bgVisible
        ? {
            backgroundColor: "color-mix(in oklch, var(--surface) 62%, transparent)",
            // 会长气泡往往很长、数量多；模糊收窄到 2px（大面积 blur 在手机上是主要开销）
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
          }
        : undefined,
    [bgVisible],
  );
  // 用户气泡短，去掉 backdrop blur，只保留半透明——省掉一层大面积模糊
  const userBubbleStyle = useMemo<React.CSSProperties | undefined>(
    () =>
      bgVisible
        ? { backgroundColor: "color-mix(in oklch, var(--accent-soft) 72%, transparent)" }
        : undefined,
    [bgVisible],
  );

  // 时间线渲染（附日期分隔）。长列表：默认只渲染最后 visibleCount 条
  const allItems = items ?? [];
  const hiddenCount = Math.max(0, allItems.length - visibleCount);
  const shownItems = hiddenCount > 0 ? allItems.slice(hiddenCount) : allItems;
  const rendered: React.ReactNode[] = [];
  let lastDay = "";
  let prevMasterSender: string | null = null;
  for (const it of shownItems) {
    const ts = itemTime(it);
    const dk = dayKey(ts);
    if (dk !== lastDay) {
      rendered.push(
        <div key={`day_${dk}`} className="flex items-center gap-3 py-1" aria-hidden>
          <span className="border-border flex-1 border-t" />
          <span className="text-fs-micro text-faint tracking-widest">{dayLabel(ts)}</span>
          <span className="border-border flex-1 border-t" />
        </div>,
      );
      lastDay = dk;
    }
    const msg = messageOf(it);
    if (!msg) {
      const settlementItem = it as Extract<TimelineItem, { type: "settlement" }>;
      rendered.push(
        <SettlementCard
          key={itemKey(it)}
          s={settlementItem.settlement}
          fresh={settlementItem.fresh}
          silent={ceremony != null}
        />,
      );
      continue;
    }
    if (msg.role === "user") {
      prevMasterSender = null;
      rendered.push(
        <MessageRow
          key={itemKey(it)}
          msg={msg}
          masterName={masterName}
          masterAvatar={masterAvatar}
          mode={mode}
          imageEnabled={imageEnabled}
          sceneBusy={false}
          anySceneBusy={false}
          sceneStartedAt={null}
          switched={null}
          bubbleStyle={bubbleStyle}
          userBubbleStyle={userBubbleStyle}
          onDelete={handleDeleteMessage}
          onGenerateScene={handleGenerateScene}
          onStopScene={handleStopScene}
          onOpenImage={handleOpenImage}
        />,
      );
      continue;
    }
    const sender = msg.sender || masterName;
    const switched = prevMasterSender !== null && prevMasterSender !== sender ? sender : null;
    prevMasterSender = sender;
    rendered.push(
      <MessageRow
        key={itemKey(it)}
        msg={msg}
        masterName={masterName}
        masterAvatar={masterAvatar}
        mode={mode}
        imageEnabled={imageEnabled}
        sceneBusy={sceneBusy === msg.id}
        anySceneBusy={sceneBusy !== null}
        sceneStartedAt={sceneBusy === msg.id ? sceneStartedAt : null}
        switched={switched}
        bubbleStyle={bubbleStyle}
        userBubbleStyle={userBubbleStyle}
        onDelete={handleDeleteMessage}
        onGenerateScene={handleGenerateScene}
        onStopScene={handleStopScene}
        onOpenImage={handleOpenImage}
      />,
    );
  }

  /** 点击小人：短暂播放 emote */
  function pokePet() {
    setPetReact(true);
    window.setTimeout(() => setPetReact(false), 1600);
  }
  /** 情绪表情：覆盖脸层，9 秒后回到设定表情 */
  function flashMood(face: FaceId) {
    setMoodFace(face);
    window.clearTimeout(moodTimer.current);
    moodTimer.current = window.setTimeout(() => setMoodFace(null), 9000);
  }
  const petAnim = sendingHere || serverPending || petReact ? "emote" : "idle";
  /** 渲染用描述：把当前情绪表情临时覆盖到脸层 */
  const petDescriptor: PetDescriptor | null = masterSprite
    ? {
        ...masterSprite,
        items: { ...masterSprite.items, face: moodFace ?? masterSprite.items.face },
      }
    : null;

  return (
    <main
      className="bg-bg text-fg font-body chat-home relative mx-auto flex h-dvh max-w-md flex-col"
      style={pageStyle}
    >
      {/* 顶栏 */}
      <header className="border-border bg-surface flex items-center gap-3 border-b px-4 py-3">
        <Avatar
          src={masterAvatar}
          name={masterName}
          className="border-gold-line bg-gold-soft text-gold font-display flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold"
        />
        <div>
          <h1 className="font-display text-fs-h3 font-semibold tracking-wide">
            二周目协会
          </h1>
          <p className="text-fs-micro text-muted tracking-widest">
            会长 · {masterName}
          </p>
        </div>
        <Link
          href="/records"
          className={`text-fs-meta text-muted hover:text-fg ml-auto shrink-0 transition-colors ${mode === "chat" ? "invisible" : ""}`}
        >
          聊天记录
        </Link>
      </header>

      {/* 模式切换：任务（委托管线） / 聊天（酒馆式自由 RP），两条流完全隔离 */}
      <div
        className="border-border bg-surface flex items-center gap-1 border-b px-4 py-2"
        role="tablist"
        aria-label="对话模式"
      >
        {(
          [
            { key: "quest", label: "任务" },
            { key: "chat", label: "聊天" },
          ] as { key: Mode; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={mode === t.key}
            onClick={() => switchMode(t.key)}
            className={
              mode === t.key
                ? "bg-accent text-on-accent rounded-pill px-3 py-1 text-fs-meta font-medium transition-colors"
                : "text-muted hover:text-fg rounded-pill px-3 py-1 text-fs-meta transition-colors"
            }
          >
            {t.label}
          </button>
        ))}
        <span className="text-fs-micro text-faint ml-auto">
          {mode === "chat" && greeting && greeting.greetings.length > 1 && !userSpoke ? (
            <button
              type="button"
              onClick={cycleGreeting}
              className="text-muted hover:text-fg transition-colors"
            >
              换一条开场白 ↻
            </button>
          ) : mode === "chat" && activeMasterId ? (
            <button
              type="button"
              onClick={() => setGreetingEditorOpen(true)}
              className="text-muted hover:text-fg transition-colors"
            >
              编辑开场白
            </button>
          ) : mode === "chat" ? (
            "自由对话"
          ) : (
            <span
              className="inline-block max-w-[60%] truncate align-middle"
              title={`任务页只显示与「${masterName}」的对话（结算卡片按当时在任会长归属）`}
            >
              仅显示与「{masterName}」的对话
            </span>
          )}
        </span>
      </div>

      {/* P10 会话切换条（仅聊天模式） */}
      {mode === "chat" && (
        <div className="border-border bg-surface-2 flex items-center gap-2 border-b px-4 py-1.5">
          <button
            type="button"
            className="text-fs-meta text-fg flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => setSessionMenuOpen((v) => !v)}
          >
            <span className="truncate">
              {sessions.find((s) => s.id === sessionId)?.title ?? "新的对话"}
            </span>
            <span className="text-fs-micro text-faint shrink-0">
              {sessions.length} 段 ▾
            </span>
          </button>
          <button
            type="button"
            className={`rounded-btn shrink-0 border px-2 py-0.5 text-fs-micro transition-colors ${
              background
                ? "border-gold-line text-gold hover:bg-gold-soft"
                : "border-border text-muted hover:text-fg"
            }`}
            onClick={() => setBgPanelOpen((v) => !v)}
            aria-expanded={bgPanelOpen}
          >
            背景
          </button>
          <button
            type="button"
            className="border-accent-line text-accent rounded-btn shrink-0 border px-2 py-0.5 text-fs-micro transition-colors hover:bg-accent-soft"
            onClick={newSession}
          >
            + 新对话
          </button>
        </div>
      )}

      {/* 会话背景设置（每个会话一张图；任务页不受影响） */}
      {mode === "chat" && bgPanelOpen && (
        <div className="border-border bg-surface space-y-2 border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <label className="border-accent-line text-accent hover:bg-accent-soft rounded-btn cursor-pointer border px-3 py-1 text-fs-micro transition-colors">
              {bgUploading ? "上传中……" : "上传背景图"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={bgUploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void setBackgroundImage(f);
                  e.target.value = "";
                }}
              />
            </label>
            {background && (
              <button
                type="button"
                className="text-fs-micro text-muted hover:text-danger-text transition-colors disabled:opacity-40"
                disabled={bgUploading}
                onClick={() => void setBackgroundImage(null)}
              >
                清除背景
              </button>
            )}
          </div>
          <p className="text-fs-micro text-faint leading-relaxed">
            每个会话一张背景；任务页保持原样。
          </p>
        </div>
      )}

      {/* P10 会话列表（下拉浮层） */}
      {mode === "chat" && sessionMenuOpen && (
        <div className="border-border bg-surface border-b px-4 py-2">
          <div className="space-y-1.5">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-2 rounded-btn px-2 py-1.5 ${
                  s.id === sessionId ? "bg-accent-soft" : "hover:bg-surface-2"
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => switchSession(s.id)}
                >
                  <span className="text-fs-sm text-fg block truncate">{s.title}</span>
                  <span className="text-fs-micro text-faint">
                    {s.messageCount} 条消息
                  </span>
                </button>
                <button
                  type="button"
                  className="text-fs-micro text-muted hover:text-fg shrink-0"
                  onClick={() => renameSession(s.id, s.title)}
                >
                  改名
                </button>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    className="text-fs-micro text-muted hover:text-danger-text shrink-0"
                    onClick={() => deleteSession(s.id, s.title)}
                  >
                    删除
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 消息流 */}
      <div
        ref={scrollRef}
        className="chat-scroll flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-4"
        onScroll={onScroll}
      >
        {items === null && (
          <p className="text-muted mt-10 text-center text-sm">
            正在翻开协会的登记簿……
          </p>
        )}
        {items !== null && hasEarlier && mode === "quest" && (
          <div className="flex justify-center">
            <Link
              href="/records"
              className="border-border text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-meta transition-colors"
            >
              更早的对话在「聊天记录」→
            </Link>
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={expandEarlier}
              className="border-border text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-meta transition-colors"
            >
              展开更早的 {hiddenCount} 条
            </button>
          </div>
        )}
        {mode === "chat" && hiddenCount === 0 && hasEarlier && (
          <div className="flex justify-center">
            <button
              type="button"
              disabled={chatLoadingEarlier}
              onClick={() => void loadEarlierChat()}
              className="border-border text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-meta transition-colors disabled:opacity-40"
            >
              {chatLoadingEarlier ? "正在翻更早的记录……" : "加载更早的对话"}
            </button>
          </div>
        )}
        {items !== null && items.length === 0 && !sendingHere && !serverPending && (
          <p className="text-muted mt-10 text-center text-sm">
            {mode === "chat"
              ? "屋子里只有你和会长两个人。说点什么吧。"
              : "协会的门虚掩着，灯火还亮着。说点什么吧。"}
          </p>
        )}
        {rendered}
        {(sendingHere || serverPending) && (
          <div className="flex items-start gap-2">
            <Avatar
              src={masterAvatar}
              name={masterName}
              className="border-border bg-surface-3 text-muted mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs"
            />
            <div
              className="border-border bg-surface rounded-card rounded-tl-chip min-w-0 max-w-[85%] border px-4 py-2 text-fs-body whitespace-pre-wrap"
              style={bubbleStyle}
            >
              {streamingReply ? (
                <ChatText text={streamingReply} />
              ) : (
                <span className="vn-typing" style={{ color: "var(--accent)" }}>
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="border-danger text-danger-text rounded-card border px-4 py-3 text-fs-sm">
            {error}
          </div>
        )}
        {sceneError && (
          <div className="border-danger rounded-card border px-4 py-3">
            <p className="text-danger-text font-display text-fs-h3">配图失败</p>
            <p className="text-fs-meta text-danger-text mt-1 leading-relaxed">{sceneError}</p>
          </div>
        )}
      </div>

      {/* 提示条（对账提醒等；结算反馈走时间线卡片） */}
      {notices.length > 0 && (
        <div className="border-border bg-surface space-y-1 border-t px-4 py-2">
          {notices.slice(-3).map((n) => (
            <p key={n.at} className="text-gold font-numeric text-fs-sm">
              {n.text}
            </p>
          ))}
        </div>
      )}

      {/* 输入区（草稿状态在组件内部，打字不重渲染时间线） */}
      <Composer mode={mode} disabled={sending || serverPending} onSend={send} />

      {/* 回到最新：滚离底部时浮出 */}
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="回到最新"
          className="border-gold-line bg-surface text-gold shadow-glow-gold absolute right-4 bottom-24 z-30 flex h-9 w-9 items-center justify-center rounded-full border text-base"
        >
          ↓
        </button>
      )}

      {/* 会长像素小人（桌面宠物）：默认 idle；生成中/点击时弹 emote；情绪换脸。设置页可关 */}
      {showPet && petDescriptor && (
        <button
          type="button"
          onClick={pokePet}
          aria-label={`和${masterName}互动`}
          className="absolute bottom-28 left-3 z-20 transition-transform active:scale-95"
        >
          <PixelPet
            descriptor={petDescriptor}
            animation={petAnim}
            display={64}
            className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
          />
        </button>
      )}

      <BottomNav />

      {/* 升级 / 晋段仪式（ceremony 事件来自引擎结算） */}
      {ceremony && (
        <CeremonyOverlay event={ceremony} onDone={() => setCeremony(null)} />
      )}

      {/* 单条消息删除确认 */}
      {deleteTarget && (
        <ConfirmDialog
          title="删除这条消息？"
          description={`「${deleteTarget.preview.slice(0, 40)}${deleteTarget.preview.length > 40 ? "…" : ""}」删除后无法恢复，它的配图也会一起删掉。`}
          confirmLabel="删除"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* P9 开场白编辑 */}
      {greetingEditorOpen && activeMasterId && (
        <GreetingEditor
          masterId={activeMasterId}
          masterName={masterName}
          onClose={() => setGreetingEditorOpen(false)}
          onSaved={() => loadTimeline("chat")}
        />
      )}

      {/* 配图预览 / 放大 */}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}

      {/* 会话改名 / 删除（应用内弹窗） */}
      {renameTarget && (
        <PromptDialog
          title="会话名称"
          initialValue={renameTarget.title}
          confirmLabel="保存"
          onSubmit={(v) => {
            const t = renameTarget;
            setRenameTarget(null);
            if (v) sessionAction("rename", { sessionId: t.id, title: v });
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      {sessionDeleteTarget && (
        <ConfirmDialog
          title="删除这段对话？"
          description={`「${sessionDeleteTarget.title}」的聊天记录和它的对话记忆会一起消失，无法恢复。`}
          confirmLabel="删除"
          onConfirm={() => {
            const t = sessionDeleteTarget;
            setSessionDeleteTarget(null);
            sessionAction("delete", { sessionId: t.id });
          }}
          onCancel={() => setSessionDeleteTarget(null)}
        />
      )}
    </main>
  );
}
