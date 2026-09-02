import { lazy, Suspense } from "react";

import { preloadMarkdownEditor } from "../lib/preloadMarkdownEditor";

const LazyMarkdownEditor = lazy(async () => {
  const module = await preloadMarkdownEditor();
  return { default: module.MarkdownEditor };
});

interface DeferredMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
}

export function DeferredMarkdownEditor(props: DeferredMarkdownEditorProps) {
  return (
    <Suspense fallback={<div className="markdown-editor-loading">正在载入 Markdown 编辑器…</div>}>
      <LazyMarkdownEditor {...props} />
    </Suspense>
  );
}
