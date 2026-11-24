"use client";

/**
 * 时间线里的单条消息行。
 *
 * 性能要点（这是对话页最容易卡的地方）：
 * - 用 memo 包住：流式回复、输入框打字、每秒作画计时都不会重新渲染历史消息；
 * - 作画计时下沉到 SceneProgress，自己持有 1 秒定时器，
 *   避免整个对话页每秒重渲染；
 * - 传给 memo 组件的回调与样式都必须稳定（父组件用 useCallback/useMemo），
 *   否则浅比较失效，memo 白做。
 */

import { memo, useEffect, useState, type CSSProperties } from "react";
import Avatar from "@/components/Avatar";
import ChatText from "@/components/ChatText";
import type { ApiMessage, Mode } from "./types";

/** 作画计时：只有正在生成的那条消息渲染它，计时器也只驱动这一小块 */
function SceneProgress({
  startedAt,
  onStop,
}: {
  startedAt: number | null;
  onStop: () => void;
}) {
  // 初值固定 0：服务端与客户端时钟不同，按 Date.now() 初始化会造成 hydration 不一致；
  // 挂载后的 effect 立刻校正到真实已用时间。
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt == null) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="text-fs-micro text-accent mt-1.5 flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-2">
        <span className="vn-typing" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        正在作画… 已 {elapsed}s
      </span>
      <span className="text-faint">（后台生成，切页 / 锁屏都不影响）</span>
      <button
        type="button"
        onClick={onStop}
        className="border-danger text-danger-text rounded-btn border px-2 py-0.5 transition-colors hover:bg-surface-2"
      >
        停止
      </button>
    </div>
  );
}

export interface MessageRowProps {
  msg: ApiMessage;
  masterName: string;
  masterAvatar: string | null;
  mode: Mode;
  imageEnabled: boolean;
  /** 这条消息是否正在生成配图 */
  sceneBusy: boolean;
  /** 是否有任意一条消息正在生成（用于禁用其它配图按钮） */
  anySceneBusy: boolean;
  /** 仅当本条消息在作画时有值 */
  sceneStartedAt: number | null;
  /** 上一条会长消息的发送者（换人时显示接管分隔线） */
  switched: string | null;
  bubbleStyle?: CSSProperties;
  userBubbleStyle?: CSSProperties;
  onDelete: (msg: ApiMessage) => void;
  onGenerateScene: (messageId: string) => void;
  onStopScene: () => void;
  onOpenImage: (url: string) => void;
}

function MessageRowInner({
  msg,
  masterName,
  masterAvatar,
  mode,
  imageEnabled,
  sceneBusy,
  anySceneBusy,
  sceneStartedAt,
  switched,
  bubbleStyle,
  userBubbleStyle,
  onDelete,
  onGenerateScene,
  onStopScene,
  onOpenImage,
}: MessageRowProps) {
  if (msg.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div
          className="border-accent-line bg-accent-soft rounded-card rounded-br-chip min-w-0 max-w-[80%] border px-4 py-2 text-fs-body leading-relaxed break-words"
          style={userBubbleStyle}
        >
          {msg.content}
        </div>
        <button
          type="button"
          onClick={() => onDelete(msg)}
          className="text-fs-micro text-faint hover:text-danger-text mt-1 transition-colors"
        >
          删除
        </button>
      </div>
    );
  }

  const sender = msg.sender || masterName;
  return (
    <div>
      {switched && (
        <div className="flex items-center gap-3 py-1" aria-hidden>
          <span className="border-border flex-1 border-t" />
          <span className="text-fs-micro text-muted tracking-widest">
            {switched} 接管了协会
          </span>
          <span className="border-border flex-1 border-t" />
        </div>
      )}
      <div className="flex items-start gap-2">
        <Avatar
          src={sender === masterName ? masterAvatar : null}
          name={sender}
          className="border-border bg-surface-3 text-muted mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs"
        />
        <div className="min-w-0">
          <p className="text-fs-micro text-muted mb-1 tracking-widest">{sender}</p>
          <div
            className="border-border bg-surface shadow-card rounded-card rounded-tl-chip max-w-[85%] border px-4 py-2 text-fs-body whitespace-pre-wrap leading-relaxed"
            style={bubbleStyle}
          >
            <ChatText text={msg.content} />
          </div>
          {msg.image && (
            <button
              type="button"
              onClick={() => onOpenImage(msg.image as string)}
              aria-label="查看大图"
              className="block text-left"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={msg.image}
                alt=""
                loading="lazy"
                className="border-border mt-2 w-full max-w-[85%] rounded-card border"
              />
            </button>
          )}
          {!msg.image && sceneBusy && (
            <SceneProgress startedAt={sceneStartedAt} onStop={onStopScene} />
          )}
          <div className="text-fs-micro mt-1 flex flex-wrap items-center gap-3">
            {mode === "chat" && imageEnabled && !msg.image && !sceneBusy && (
              <button
                type="button"
                disabled={anySceneBusy}
                onClick={() => onGenerateScene(msg.id)}
                className="text-faint hover:text-accent transition-colors disabled:opacity-40"
              >
                {anySceneBusy ? "另一张正在作画…" : "🖼 给这一幕配图"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(msg)}
              className="text-faint hover:text-danger-text transition-colors"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(MessageRowInner);
