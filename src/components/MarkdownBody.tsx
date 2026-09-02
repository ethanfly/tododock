import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isDesktopRuntime } from "../lib/api";
import { isSafeLocalImageSrc } from "../lib/safeImage";

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
      urlTransform={(url) => (isSafeLocalImageSrc(url) ? url : defaultUrlTransform(url))}
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
          if (isSafeLocalImageSrc(source)) {
            return <img className="markdown-inline-image" src={source} alt={label} />;
          }
          return (
            <span
              className="markdown-image-placeholder"
              role="img"
              aria-label={`图片：${label}`}
              data-markdown-image-source={source}
              data-markdown-image-alt={alt ?? ""}
              title="为保持本地优先，远程 Markdown 图片不会自动联网加载"
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
