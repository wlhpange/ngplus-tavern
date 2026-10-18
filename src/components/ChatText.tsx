/**
 * 聊天文本渲染（两模式共用）：按 Markdown 渲染（GFM：表格/删除线/任务列表等）。
 *
 * 安全：使用 rehype-sanitize 白名单，且**不挂 rehype-raw**——模型输出里的原始
 * HTML 标签（<img onerror>、<script> 等）不会被解析执行，只会当作纯文本显示。
 * 图片走 Markdown 语法 `![]()`，链接强制新窗口 + noopener。
 *
 * 说明：这不是 sanitizeReply（那是任务管线的 AI 腔清洗，刻意不作用于聊天模式）；
 * 这里只是**纯显示层**的呈现优化。
 */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/** 在 GitHub 默认白名单上放开图片/链接所需的属性与协议 */
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "src", "alt", "title", "width", "height"],
    a: [...(defaultSchema.attributes?.a ?? []), "href", "title", "target", "rel"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
};

export default function ChatText({ text }: { text: string }) {
  // 宏兜底：服务端已替换 {{user}}/{{char}}，这里清掉任何残留的 {{...}}
  const clean = text.replace(/\{\{[^{}]*\}\}/g, "");
  return (
    <div className="chat-md break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SCHEMA]]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" className="text-accent underline">
              {children}
            </a>
          ),
          img: ({ ...props }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img {...props} alt={props.alt ?? ""} className="my-1 max-w-full rounded-btn border border-border" />
          ),
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 leading-relaxed">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 leading-relaxed">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted">{children}</blockquote>
          ),
          h1: ({ children }) => <p className="font-display text-fs-h3">{children}</p>,
          h2: ({ children }) => <p className="font-display text-fs-h3">{children}</p>,
          h3: ({ children }) => <p className="font-semibold">{children}</p>,
          h4: ({ children }) => <p className="font-semibold">{children}</p>,
          h5: ({ children }) => <p className="font-semibold">{children}</p>,
          h6: ({ children }) => <p className="font-semibold">{children}</p>,
          code: ({ children, className }) => (
            <code
              className={`${className ?? ""} rounded-chip bg-surface-3 px-1 py-0.5 font-numeric text-fs-micro`}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1 overflow-x-auto rounded-tile bg-surface-3 p-2 text-fs-micro leading-relaxed">
              {children}
            </pre>
          ),
          hr: () => <hr className="border-border my-2" />,
          table: ({ children }) => (
            <div className="my-1 overflow-x-auto">
              <table className="border-collapse text-fs-micro">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-0.5 text-left">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-0.5">{children}</td>,
        }}
      >
        {clean}
      </Markdown>
    </div>
  );
}
