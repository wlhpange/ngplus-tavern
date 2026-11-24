"use client";

/**
 * 聊天文本渲染（两模式共用）：按 Markdown 渲染（GFM：表格/删除线/任务列表等）。
 *
 * 性能：Markdown 解析器（react-markdown / remark / rehype）体积不小，
 * 这里用 lazy 拆出 MarkdownBody，聊天消息出现时才加载；加载完成前先显示纯文本。
 * 历史消息正文不变时也不重复渲染（memo）。
 *
 * 安全：MarkdownBody 使用 rehype-sanitize 白名单，且不挂 rehype-raw。
 */

import { Suspense, lazy, memo } from "react";

const MarkdownBody = lazy(() => import("./MarkdownBody"));

function ChatText({ text }: { text: string }) {
  // 宏兜底：服务端已替换 {{user}}/{{char}}，这里清掉任何残留的 {{...}}
  const clean = text.replace(/\{\{[^{}]*\}\}/g, "");
  return (
    <Suspense
      fallback={<span className="whitespace-pre-wrap break-words">{clean}</span>}
    >
      <MarkdownBody text={clean} />
    </Suspense>
  );
}

/** 历史消息的正文不变就不需要重新解析 Markdown：对话页每次流式/打字都重渲染，memo 收益明显 */
export default memo(ChatText);
