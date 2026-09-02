import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { isDesktopRuntime } from "../lib/api";

interface MarkdownBodyProps {
  markdown: string;
}

function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function MarkdownBody({ markdown }: MarkdownBodyProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a({ href, children }) {
          const safeHref = href && isSafeUrl(href) ? href : undefined;
          return (
            <a
              href={safeHref}
              onClick={(event) => {
                event.preventDefault();
                if (!safeHref) return;
                if (isDesktopRuntime()) void openUrl(safeHref);
                else window.open(safeHref, "_blank", "noopener,noreferrer");
              }}
            >
              {children}
            </a>
          );
        },
        img({ src, alt }) {
          const source = typeof src === "string" ? src : "";
          const label = alt?.trim() || "未命名图片";
          return (
            <span
              className="markdown-image-placeholder"
              role="img"
              aria-label={`图片：${label}`}
              data-markdown-image-source={source}
              data-markdown-image-alt={alt ?? ""}
              title="为保持本地优先，Markdown 图片不会自动联网加载"
            >
              图片 · {label}
            </span>
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
