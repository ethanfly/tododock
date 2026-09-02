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
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { filesToCapturedImages, imageFilesFromDataTransfer } from "../lib/clipboardImages";
import { editableElementToMarkdown, isLikelyMarkdownSource, plainTextEditorToMarkdown } from "../lib/markdownEditor";
import { DATE_POPOVER_INSET, placePopover } from "../lib/popoverPlacement";
import { escapeHtmlAttribute, isSafeLocalImageSrc } from "../lib/safeImage";
import { MAX_TODO_BODY_CHARS } from "../types";
import { MarkdownBody } from "./MarkdownBody";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
}

type EditorMode = "visual" | "source";

interface LinkDraft {
  href: string;
  text: string;
}

function safeEditorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function normalizeEditorUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(https?|mailto):/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[\w.-]+/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
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
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPopover, setLinkPopover] = useState({ top: 0, left: 0, width: 280, height: 188 });
  const editorRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const linkPopoverRef = useRef<HTMLDivElement>(null);
  const hrefInputRef = useRef<HTMLInputElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const linkOpenRef = useRef(false);
  const focusedRef = useRef(false);
  const composingRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(null);
  const forceVisualSyncRef = useRef(false);
  const renderTimerRef = useRef<number | undefined>(undefined);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const linkTitleId = useId();

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

  const linkOpen = linkDraft !== null;
  useEffect(() => {
    if (!linkOpen) return undefined;
    function place() {
      const rect = linkButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setLinkPopover(placePopover({
        field: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        popover: { width: Math.min(300, Math.max(240, window.innerWidth - 24)), height: 196 },
        inset: DATE_POPOVER_INSET,
      }));
    }
    place();
    const frame = window.requestAnimationFrame(place);
    queueMicrotask(() => hrefInputRef.current?.focus());
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (linkButtonRef.current?.contains(target) || linkPopoverRef.current?.contains(target)) return;
      closeLinkDialog();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeLinkDialog();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", place);
    };
  }, [linkOpen]);

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

  function captureEditorSelection() {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection || !editor || selection.rangeCount === 0) {
      savedRangeRef.current = null;
      return "链接";
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = null;
      return "链接";
    }
    savedRangeRef.current = range.cloneRange();
    return selection.toString().trim() || "链接";
  }

  function restoreEditorSelection() {
    const editor = editorRef.current;
    const range = savedRangeRef.current;
    editor?.focus();
    const selection = window.getSelection();
    if (!selection || !range || !editor) return;
    try {
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      placeCaretAtEnd(editor);
    }
  }

  function closeLinkDialog() {
    linkOpenRef.current = false;
    savedRangeRef.current = null;
    setLinkDraft(null);
    setLinkError(null);
    editorRef.current?.focus();
  }

  function openLinkDialog() {
    const text = captureEditorSelection();
    linkOpenRef.current = true;
    setLinkError(null);
    setLinkDraft({ href: "", text });
  }

  function confirmLink() {
    if (!linkDraft) return;
    const href = normalizeEditorUrl(linkDraft.href);
    if (!href || !safeEditorUrl(href)) {
      setLinkError("请输入 http、https 或 mailto 链接");
      return;
    }
    const text = linkDraft.text.trim() || "链接";
    restoreEditorSelection();
    runCommand("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`);
    closeLinkDialog();
  }

  function insertPlainText(text: string) {
    document.execCommand("insertText", false, text);
    emitVisualValue();
    requestVisualMarkdownSync();
  }

  async function insertImageFiles(files: File[]) {
    const images = await filesToCapturedImages(files);
    const usable = images.filter((image) => isSafeLocalImageSrc(image.dataUrl));
    if (usable.length === 0) return;
    editorRef.current?.focus();
    const html = usable
      .map((image) => `<img class="markdown-inline-image" src="${escapeHtmlAttribute(image.dataUrl)}" alt="${escapeHtmlAttribute(image.name)}">`)
      .join("<br>");
    const nextLength = (mode === "source" ? value : currentVisualMarkdown()).length + usable.reduce((sum, image) => sum + image.dataUrl.length, 0);
    if (nextLength > MAX_TODO_BODY_CHARS) return;
    if (mode === "source") {
      const markdown = usable.map((image) => `![${image.name}](${image.dataUrl})`).join("\n\n");
      onChange(value ? `${value}\n\n${markdown}` : markdown);
      return;
    }
    runCommand("insertHTML", html);
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement | HTMLTextAreaElement>) {
    const files = imageFilesFromDataTransfer(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void insertImageFiles(files);
      return;
    }
    if (mode === "visual") {
      event.preventDefault();
      insertPlainText(event.clipboardData.getData("text/plain"));
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement | HTMLTextAreaElement>) {
    const files = imageFilesFromDataTransfer(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      void insertImageFiles(files);
      return;
    }
    if (mode === "visual") {
      event.preventDefault();
      insertPlainText(event.dataTransfer.getData("text/plain"));
    }
  }

  function switchMode(next: EditorMode) {
    if (next === mode) return;
    if (mode === "visual") emitVisualValue();
    focusedRef.current = false;
    setFocused(false);
    closeLinkDialog();
    setMode(next);
  }

  const linkDialog = linkDraft ? createPortal(
    <div
      ref={linkPopoverRef}
      className="markdown-link-popover"
      style={{ top: linkPopover.top, left: linkPopover.left, width: linkPopover.width, maxHeight: linkPopover.height }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={linkTitleId}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        confirmLink();
      }}
    >
      <strong id={linkTitleId}>插入链接</strong>
      <label>
        链接
        <input
          ref={hrefInputRef}
          value={linkDraft.href}
          placeholder="https:// 或 mailto:"
          aria-label="链接地址"
          onChange={(event) => {
            setLinkDraft({ ...linkDraft, href: event.target.value });
            setLinkError(null);
          }}
        />
      </label>
      <label>
        显示文本
        <input
          value={linkDraft.text}
          aria-label="链接显示文本"
          onChange={(event) => setLinkDraft({ ...linkDraft, text: event.target.value })}
        />
      </label>
      {linkError && <p className="field-error" role="alert">{linkError}</p>}
      <div className="markdown-link-popover-actions">
        <button type="button" onClick={closeLinkDialog}>取消</button>
        <button type="button" className="primary-button compact" onClick={confirmLink}>确定</button>
      </div>
    </div>,
    document.body,
  ) : null;

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
            <button
              ref={linkButtonRef}
              type="button"
              aria-label="链接"
              title="链接"
              aria-haspopup="dialog"
              aria-expanded={linkDraft !== null}
              onMouseDown={(event) => event.preventDefault()}
              onClick={openLinkDialog}
            >
              <Link2 size={15} />
            </button>
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
            if (linkOpenRef.current) return;
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
          onDragOver={(event) => {
            if (imageFilesFromDataTransfer(event.dataTransfer).length > 0) event.preventDefault();
          }}
        />
      ) : (
        <textarea
          className="markdown-source-surface"
          aria-label={`${ariaLabel}，Markdown 源码`}
          value={value}
          maxLength={MAX_TODO_BODY_CHARS}
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          onDrop={onDrop}
        />
      )}

      <div ref={templateRef} className="markdown-editor-template" aria-hidden="true">
        {mode === "visual" && (!focused || previewMarkdown !== null) && (
          <MarkdownBody markdown={previewMarkdown ?? value} />
        )}
      </div>
      {linkDialog}
    </section>
  );
}
