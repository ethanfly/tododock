import { ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import { localTimeZoneLabel } from "../lib/date";
import { DateTimePicker } from "./DateTimePicker";
import { preloadMarkdownEditor } from "../lib/preloadMarkdownEditor";
import { DeferredMarkdownEditor } from "./DeferredMarkdownEditor";

interface CreateTodoDialogProps {
  submitting: boolean;
  titleInputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (input: { title: string; body: string; deadline: string }) => Promise<void> | void;
  onClose: () => void;
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
].join(",");

export function CreateTodoDialog({ submitting, titleInputRef, onSubmit, onClose }: CreateTodoDialogProps) {
  const dialogTitleId = useId();
  const deadlineId = useId();
  const markdownId = "tododock-create-markdown";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deadline, setDeadline] = useState("");
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [markdownMounted, setMarkdownMounted] = useState(false);
  const composingRef = useRef(false);

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (composingRef.current) return;
    const nextTitle = title.trim();
    if (!nextTitle || submitting) return;
    await onSubmit({ title: nextTitle, body, deadline });
  }

  function onTitleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <form
      className={`window-form ${markdownOpen ? "is-markdown-open" : ""}`}
      aria-labelledby={dialogTitleId}
      onSubmit={(event) => void submit(event)}
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
        <span>Enter 添加</span>
        <button className="primary-button" type="submit" disabled={!title.trim() || submitting}>
          {submitting ? "添加中…" : "添加"}
        </button>
      </footer>
    </form>
  );
}
