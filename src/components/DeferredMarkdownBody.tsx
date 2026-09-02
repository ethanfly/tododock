import { lazy, Suspense } from "react";

const LazyMarkdownBody = lazy(async () => {
  const module = await import("./MarkdownBody");
  return { default: module.MarkdownBody };
});

export function DeferredMarkdownBody({ markdown }: { markdown: string }) {
  return (
    <Suspense fallback={<span className="markdown-loading">正在排版 Markdown…</span>}>
      <LazyMarkdownBody markdown={markdown} />
    </Suspense>
  );
}
