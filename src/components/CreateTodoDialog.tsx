import { ChevronDown, ImagePlus, Sparkles, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import { filesToCapturedImages, imageFilesFromDataTransfer, MAX_CAPTURE_IMAGES, readClipboardImageFiles, type CapturedImage } from "../lib/clipboardImages";
import { localTimeZoneLabel } from "../lib/date";
import { preloadMarkdownEditor } from "../lib/preloadMarkdownEditor";
import type { GeneratedTodoDraft } from "../types";
import { DateTimePicker } from "./DateTimePicker";
import { DeferredMarkdownEditor } from "./DeferredMarkdownEditor";

interface TodoDraftInput {
  title: string;
  body: string;
  deadline: string;
}

interface CreateTodoDialogProps {
  submitting: boolean;
  titleInputRef: RefObject<HTMLInputElement | null>;
  llmEnabled: boolean;
  onSubmit: (items: TodoDraftInput[]) => Promise<void> | void;
  onGenerateFromImages: (images: CapturedImage[]) => Promise<GeneratedTodoDraft[]>;
  onClose: () => void;
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
].join(",");

export function CreateTodoDialog({
  submitting,
  titleInputRef,
  llmEnabled,
  onSubmit,
  onGenerateFromImages,
  onClose,
}: CreateTodoDialogProps) {
  const dialogTitleId = useId();
  const deadlineId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const markdownId = "tododock-create-markdown";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deadline, setDeadline] = useState("");
  const [extraDrafts, setExtraDrafts] = useState<TodoDraftInput[]>([]);
  const [images, setImages] = useState<CapturedImage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [markdownMounted, setMarkdownMounted] = useState(false);
  const composingRef = useRef(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [titleInputRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (event.target instanceof Element && event.target.closest(".markdown-editor, .markdown-link-popover")) return;
      const files = imageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void addImageFiles(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  async function addImageFiles(files: File[]) {
    try {
      const next = await filesToCapturedImages(files, imagesRef.current.length);
      if (next.length === 0) return;
      setImages((current) => [...current, ...next].slice(0, MAX_CAPTURE_IMAGES));
      setGenerateError(null);
    } catch (cause) {
      setGenerateError(cause instanceof Error ? cause.message : "无法读取图片");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (composingRef.current || generating) return;
    const nextTitle = title.trim();
    if (!nextTitle || submitting) return;
    const extras = extraDrafts
      .map((draft) => ({ ...draft, title: draft.title.trim() }))
      .filter((draft) => draft.title);
    await onSubmit([{ title: nextTitle, body, deadline }, ...extras]);
  }

  function onTitleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function applyGeneratedDrafts(drafts: GeneratedTodoDraft[]) {
    const [first, ...rest] = drafts;
    if (!first) return;
    setTitle(first.title);
    setBody(first.body);
    setDeadline(first.deadline ?? "");
    setExtraDrafts(rest.map((draft) => ({
      title: draft.title,
      body: draft.body,
      deadline: draft.deadline ?? "",
    })));
    if (first.body.trim() || rest.some((draft) => draft.body.trim())) {
      setMarkdownMounted(true);
      setMarkdownOpen(true);
    }
  }

  async function generateFromImages(source: CapturedImage[]) {
    if (!llmEnabled || generating || submitting) return;
    if (source.length === 0) {
      setGenerateError("请先粘贴、拖放或选择图片");
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      const drafts = await onGenerateFromImages(source);
      applyGeneratedDrafts(drafts);
    } catch (cause) {
      setGenerateError(cause instanceof Error ? cause.message : "无法根据图片生成待办");
    } finally {
      setGenerating(false);
    }
  }

  async function pasteAndGenerate() {
    const clipboardFiles = await readClipboardImageFiles();
    let next = images;
    if (clipboardFiles.length > 0) {
      const captured = await filesToCapturedImages(clipboardFiles, images.length);
      next = [...images, ...captured].slice(0, MAX_CAPTURE_IMAGES);
      setImages(next);
    }
    if (next.length === 0) {
      setGenerateError("剪贴板没有图片。请先复制截图，或拖放/选择图片后再生成。");
      return;
    }
    await generateFromImages(next);
  }

  const itemCount = 1 + extraDrafts.filter((draft) => draft.title.trim()).length;
  const busy = submitting || generating;

  return (
    <form
      className={`window-form ${markdownOpen ? "is-markdown-open" : ""}`}
      aria-labelledby={dialogTitleId}
      onSubmit={(event) => void submit(event)}
      onDragOver={(event) => {
        if (imageFilesFromDataTransfer(event.dataTransfer).length > 0) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = imageFilesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        void addImageFiles(files);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector)];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h1 id={dialogTitleId} className="sr-only">新建待办</h1>
      <input
            ref={titleInputRef}
            value={title}
            maxLength={240}
            placeholder="记录下一件事…"
            aria-label="待办内容"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={onTitleKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
          />

          <label className="field-label" htmlFor={deadlineId}>截止时间</label>
          <DateTimePicker id={deadlineId} aria-label="截止时间" value={deadline} onChange={setDeadline} />
          <span className="field-hint">{localTimeZoneLabel()}</span>

          <section className="create-image-capture" aria-label="用图片生成待办">
            <div className="create-image-capture-header">
              <strong>图片生成待办</strong>
              <span>{llmEnabled ? "可粘贴多张截图，一次生成一条或多条待办" : "在设置中填写大模型端点和密钥后可用"}</span>
            </div>
            {images.length > 0 && (
              <ul className="create-image-strip">
                {images.map((image) => (
                  <li key={image.id}>
                    <img src={image.dataUrl} alt={image.name} />
                    <button
                      type="button"
                      aria-label={`移除 ${image.name}`}
                      onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="create-image-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy || images.length >= MAX_CAPTURE_IMAGES}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus size={14} />
                添加图片
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!llmEnabled || busy}
                onClick={() => void pasteAndGenerate()}
              >
                <Sparkles size={14} />
                {generating ? "生成中…" : "从剪贴板生成"}
              </button>
              {images.length > 0 && (
                <button
                  type="button"
                  className="text-button"
                  disabled={!llmEnabled || busy}
                  onClick={() => void generateFromImages(images)}
                >
                  用已添加图片生成
                </button>
              )}
            </div>
            {generateError && <p className="field-error" role="alert">{generateError}</p>}
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                if (files.length > 0) void addImageFiles(files);
              }}
            />
          </section>

          {extraDrafts.length > 0 && (
            <ul className="create-extra-drafts" aria-label="将一并创建的待办">
              {extraDrafts.map((draft, index) => (
                <li key={`${draft.title}-${index}`}>
                  <input
                    value={draft.title}
                    maxLength={240}
                    aria-label={`额外待办 ${index + 1} 标题`}
                    onChange={(event) => setExtraDrafts((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, title: event.target.value } : item
                    )))}
                  />
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`移除额外待办 ${index + 1}`}
                    onClick={() => setExtraDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="create-markdown-toggle">
            <button
              type="button"
              className="text-button"
              aria-expanded={markdownOpen}
              aria-controls={markdownId}
              onPointerEnter={() => void preloadMarkdownEditor()}
              onFocus={() => void preloadMarkdownEditor()}
              onClick={() => {
                void preloadMarkdownEditor();
                setMarkdownMounted(true);
                setMarkdownOpen((value) => !value);
              }}
            >
              <ChevronDown size={15} />
              {markdownOpen ? "收起 Markdown 备注" : "展开 Markdown 备注"}
            </button>
          </div>
          {markdownMounted && (
            <div id={markdownId} className={`create-markdown-field ${markdownOpen ? "" : "is-collapsed"}`}>
              <DeferredMarkdownEditor
                value={body}
                onChange={setBody}
                ariaLabel="新建待办 Markdown 备注"
              />
            </div>
          )}

      <footer className="editor-footer">
        <span>{itemCount > 1 ? `Enter 添加 ${itemCount} 项` : "Enter 添加"}</span>
        <button className="primary-button" type="submit" disabled={!title.trim() || busy}>
          {submitting ? "添加中…" : itemCount > 1 ? `添加 ${itemCount} 项` : "添加"}
        </button>
      </footer>
    </form>
  );
}
