import {
  Bold,
  Braces,
  Code2,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Sparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { editableElementToMarkdown, isLikelyMarkdownSource, plainTextEditorToMarkdown } from "../lib/markdownEditor";
import { MarkdownBody } from "./MarkdownBody";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
}

type EditorMode = "visual" | "source";

function safeEditorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function prepareTaskLists(editor: HTMLElement) {
  editor.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((checkbox) => {
    checkbox.disabled = false;
    checkbox.contentEditable = "false";
    const item = checkbox.closest("li");
    item?.classList.add("task-list-item");
    item?.parentElement?.classList.add("contains-task-list");
  });
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function MarkdownEditor({ value, onChange, ariaLabel, compact = false }: MarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const [focused, setFocused] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);
  const composingRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(null);
  const forceVisualSyncRef = useRef(false);
  const renderTimerRef = useRef<number | undefined>(undefined);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);

  useEffect(() => () => window.clearTimeout(renderTimerRef.current), []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const template = templateRef.current;
    if (!editor || !template) return;
    const shouldSync = !focusedRef.current || forceVisualSyncRef.current || previewMarkdown !== null;
    if (!shouldSync) return;

    const apply = () => {
      const liveEditor = editorRef.current;
      const liveTemplate = templateRef.current;
      if (!liveEditor || !liveTemplate) return false;
      if (!liveTemplate.innerHTML.trim() && (previewMarkdown ?? value).trim()) return false;
      liveEditor.innerHTML = liveTemplate.innerHTML;
      prepareTaskLists(liveEditor);
      lastSyncedRef.current = previewMarkdown ?? value;
      if (focusedRef.current) placeCaretAtEnd(liveEditor);
      forceVisualSyncRef.current = false;
      return true;
    };

    if (apply()) {
      if (previewMarkdown !== null) queueMicrotask(() => setPreviewMarkdown(null));
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (apply() && previewMarkdown !== null) setPreviewMarkdown(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focused, mode, previewMarkdown, value]);

  function currentVisualMarkdown() {
    if (!editorRef.current) return "";
    const typedMarkdown = plainTextEditorToMarkdown(editorRef.current);
    return typedMarkdown && isLikelyMarkdownSource(typedMarkdown)
      ? typedMarkdown
      : editableElementToMarkdown(editorRef.current);
  }

  function emitVisualValue() {
    const markdown = currentVisualMarkdown();
    lastSyncedRef.current = markdown;
    onChange(markdown);
  }

  function requestVisualMarkdownSync() {
    if (composingRef.current || !editorRef.current) return;
    const markdown = plainTextEditorToMarkdown(editorRef.current);
    if (!markdown || !isLikelyMarkdownSource(markdown)) return;
    forceVisualSyncRef.current = true;
    lastSyncedRef.current = markdown;
    setPreviewMarkdown(markdown);
    if (markdown !== value) onChange(markdown);
  }

  function runCommand(command: string, argument?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, argument);
    if (editorRef.current) prepareTaskLists(editorRef.current);
    emitVisualValue();
  }

  function insertLink() {
    const selected = window.getSelection()?.toString().trim() || "链接";
    const href = window.prompt("输入 http、https 或 mailto 链接");
    if (!href || !safeEditorUrl(href)) return;
    runCommand("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(selected)}</a>`);
  }

  function insertPlainText(text: string) {
    document.execCommand("insertText", false, text);
    emitVisualValue();
    requestVisualMarkdownSync();
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    insertPlainText(event.clipboardData.getData("text/plain"));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    insertPlainText(event.dataTransfer.getData("text/plain"));
  }

  function switchMode(next: EditorMode) {
    if (next === mode) return;
    if (mode === "visual") emitVisualValue();
    focusedRef.current = false;
    setFocused(false);
    setMode(next);
  }

  return (
    <section className={`markdown-editor ${compact ? "is-compact" : ""}`} aria-label={ariaLabel}>
      <div className="markdown-editor-toolbar" role="toolbar" aria-label="Markdown 格式工具">
        <div className="markdown-mode-switch" aria-label="编辑模式">
          <button type="button" className={mode === "visual" ? "is-active" : ""} aria-pressed={mode === "visual"} onClick={() => switchMode("visual")}>
            <Sparkles size={15} />所见即所得
          </button>
          <button type="button" className={mode === "source" ? "is-active" : ""} aria-pressed={mode === "source"} onClick={() => switchMode("source")}>
            <Braces size={15} />源码
          </button>
        </div>
        {mode === "visual" && (
          <div className="markdown-format-actions">
            <button type="button" aria-label="粗体" title="粗体" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("bold")}><Bold size={15} /></button>
            <button type="button" aria-label="斜体" title="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("italic")}><Italic size={15} /></button>
            <button type="button" aria-label="二级标题" title="二级标题" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("formatBlock", "h2")}><Heading2 size={15} /></button>
            <button type="button" aria-label="无序列表" title="无序列表" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertUnorderedList")}><List size={15} /></button>
            <button type="button" aria-label="有序列表" title="有序列表" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertOrderedList")}><ListOrdered size={15} /></button>
            <button type="button" aria-label="任务列表" title="任务列表" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertHTML", "<ul><li><input type='checkbox'> 待办项</li></ul>")}><ListChecks size={15} /></button>
            <button type="button" aria-label="引用" title="引用" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("formatBlock", "blockquote")}><Quote size={15} /></button>
            <button type="button" aria-label="代码块" title="代码块" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("formatBlock", "pre")}><Code2 size={15} /></button>
            <button type="button" aria-label="链接" title="链接" onMouseDown={(event) => event.preventDefault()} onClick={insertLink}><Link2 size={15} /></button>
          </div>
        )}
      </div>

      {mode === "visual" ? (
        <div
          ref={editorRef}
          className="markdown-visual-surface"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label={`${ariaLabel}，所见即所得`}
          aria-multiline="true"
          data-placeholder="直接输入并应用 Markdown 格式…"
          onFocus={() => { focusedRef.current = true; setFocused(true); }}
          onBlur={() => {
            window.clearTimeout(renderTimerRef.current);
            composingRef.current = false;
            focusedRef.current = false;
            setFocused(false);
            emitVisualValue();
            forceVisualSyncRef.current = true;
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            window.clearTimeout(renderTimerRef.current);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            emitVisualValue();
            requestVisualMarkdownSync();
          }}
          onInput={() => {
            emitVisualValue();
            if (composingRef.current) return;
            window.clearTimeout(renderTimerRef.current);
            renderTimerRef.current = window.setTimeout(() => requestVisualMarkdownSync(), 180);
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "Enter" || composingRef.current) return;
            window.clearTimeout(renderTimerRef.current);
            queueMicrotask(() => requestVisualMarkdownSync());
          }}
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) {
              event.preventDefault();
            }
            if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") {
              queueMicrotask(emitVisualValue);
            }
          }}
          onPaste={onPaste}
          onDrop={onDrop}
        />
      ) : (
        <textarea
          className="markdown-source-surface"
          aria-label={`${ariaLabel}，Markdown 源码`}
          value={value}
          maxLength={100_000}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      <div ref={templateRef} className="markdown-editor-template" aria-hidden="true">
        {mode === "visual" && (!focused || previewMarkdown !== null) && (
          <MarkdownBody markdown={previewMarkdown ?? value} />
        )}
      </div>
    </section>
  );
}
