"use client";

/**
 * 对话输入区。
 *
 * 输入草稿是组件内部状态：打字只重渲染这一小块，不会带着整条消息时间线
 * （以及其中的 Markdown）一起重渲染。
 *
 * onSend 返回 false 表示发送失败，组件会把文字还回输入框，用户可直接重发。
 */

import { useRef, useState } from "react";
import type { Mode } from "./types";

export default function Composer({
  mode,
  disabled,
  onSend,
}: {
  mode: Mode;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    const ok = await onSend(text);
    if (!ok) setDraft(text);
  }

  return (
    <div className="border-border flex items-center gap-2 border-t px-4 py-3">
      <input
        ref={inputRef}
        className="border-border-strong bg-surface-2 text-fs-sm text-fg placeholder:text-faint focus:border-accent rounded-pill flex-1 border px-4 py-2 outline-none transition-colors"
        placeholder={mode === "chat" ? "和会长随便聊聊……" : "和会长说说今天……"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
        }}
      />
      <button
        className="bg-accent text-on-accent rounded-pill px-4 py-2 text-fs-sm font-medium transition-transform active:scale-95 disabled:opacity-40"
        onClick={() => void submit()}
        disabled={disabled || !draft.trim()}
      >
        发送
      </button>
    </div>
  );
}
