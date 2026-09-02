import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { fromDateTimeLocal, localTimeZoneLabel, toDateTimeLocal } from "../lib/date";
import type { Todo, TodoPriority, UpdateTodoInput } from "../types";
import { DateTimePicker } from "./DateTimePicker";
import { DeferredMarkdownEditor } from "./DeferredMarkdownEditor";

interface TodoEditorProps {
  todo: Todo;
  defaultReminderMinutes: number;
  onClose: () => void;
  onSave: (input: UpdateTodoInput) => Promise<void>;
}

const commonReminderMinutes = [0, 5, 15, 60, 1440];
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[href]:not([aria-disabled="true"])',
].join(",");

export function TodoEditor({ todo, defaultReminderMinutes, onClose, onSave }: TodoEditorProps) {
  const titleId = useId();
  const dialogTitleId = useId();
  const deadlineId = useId();
  const reminderId = useId();
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);
  const [deadline, setDeadline] = useState(toDateTimeLocal(todo.deadlineAt));
  const [priority, setPriority] = useState<TodoPriority>(todo.priority);
  const [reminderMinutes, setReminderMinutes] = useState(
    todo.reminderMinutes?.toString() ?? (todo.deadlineAt === null ? defaultReminderMinutes.toString() : "none"),
  );
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    titleInputRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setValidationError(null);
    try {
      const deadlineAt = fromDateTimeLocal(deadline);
      await onSave({
        id: todo.id,
        title: title.trim(),
        body,
        priority,
        deadlineAt,
        reminderMinutes: deadlineAt === null || reminderMinutes === "none"
          ? null
          : Number(reminderMinutes),
      });
      onClose();
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : "无法保存 Todo");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="window-form is-markdown-open"
      aria-labelledby={dialogTitleId}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
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
          return;
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <h1 id={dialogTitleId} className="sr-only">编辑待办</h1>

      <label className="field-label" htmlFor={titleId}>标题</label>
      <input ref={titleInputRef} id={titleId} value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} />

      <div className="editor-body-label">
        <span className="field-label">Markdown 备注</span>
      </div>
      <DeferredMarkdownEditor value={body} onChange={setBody} ariaLabel="Markdown 备注" />

      <div className="editor-grid">
        <div>
          <label className="field-label" htmlFor={deadlineId}>截止时间</label>
          <DateTimePicker id={deadlineId} aria-label="截止时间" value={deadline} onChange={setDeadline} />
          <span className="field-hint">{localTimeZoneLabel()}</span>
        </div>
        <div>
          <label className="field-label" htmlFor={reminderId}>提醒</label>
          <select
            id={reminderId}
            value={reminderMinutes}
            disabled={!deadline}
            onChange={(event) => setReminderMinutes(event.target.value)}
          >
            <option value="none">不提醒</option>
            <option value="0">到期时</option>
            <option value="5">提前 5 分钟</option>
            <option value="15">提前 15 分钟</option>
            <option value="60">提前 1 小时</option>
            <option value="1440">提前 1 天</option>
            {!commonReminderMinutes.includes(Number(reminderMinutes)) && reminderMinutes !== "none" && (
              <option value={reminderMinutes}>提前 {reminderMinutes} 分钟</option>
            )}
          </select>
        </div>
      </div>

      <div className="priority-editor-row">
        <span className="field-label">优先级</span>
        <div className="priority-picker" aria-label="优先级">
          {([0, 1, 2, 3] as TodoPriority[]).map((value) => (
            <button
              key={value}
              type="button"
              className={priority === value ? "is-selected" : ""}
              onClick={() => setPriority(value)}
              aria-pressed={priority === value}
            >
              {value === 0 ? "普通" : `P${value}`}
            </button>
          ))}
        </div>
      </div>

      {validationError && <p className="field-error" role="alert">{validationError}</p>}

      <footer className="editor-footer">
        <span>Ctrl/Cmd + Enter 保存</span>
        <button className="primary-button" type="submit" disabled={!title.trim() || saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>
    </form>
  );
}
