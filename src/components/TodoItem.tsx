import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Bell,
  CalendarClock,
  Check,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import type { DragEvent } from "react";

import { describeDeadline } from "../lib/date";
import type { Todo } from "../types";
import { DeferredMarkdownBody } from "./DeferredMarkdownBody";
import { IconButton } from "./IconButton";

interface TodoItemProps {
  todo: Todo;
  now: number;
  onToggle: (todo: Todo) => void;
  onArchive: (todo: Todo, archived: boolean) => void;
  onEdit: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  reorderEnabled: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (todo: Todo, direction: -1 | 1) => void;
  onDrop: (draggedId: string, targetId: string) => void;
}

export function TodoItem({
  todo,
  now,
  onToggle,
  onArchive,
  onEdit,
  onDelete,
  reorderEnabled,
  isFirst,
  isLast,
  onMove,
  onDrop,
}: TodoItemProps) {
  const deadline = describeDeadline(todo.deadlineAt, now);
  const overdue = todo.deadlineAt !== null && todo.deadlineAt < now && todo.status === "open";

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!reorderEnabled) return;
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("application/x-tododock-id");
    if (draggedId) onDrop(draggedId, todo.id);
  }

  return (
    <article
      className={`todo-card ${todo.status === "completed" ? "is-completed" : ""} ${todo.status === "archived" ? "is-archived" : ""}`}
      aria-roledescription={reorderEnabled ? "可排序 Todo" : undefined}
      onDragOver={(event) => {
        if (reorderEnabled) event.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <span
        className={`drag-handle ${reorderEnabled ? "" : "is-disabled"}`}
        role={reorderEnabled ? "button" : undefined}
        tabIndex={reorderEnabled ? 0 : -1}
        aria-label={reorderEnabled ? `拖动排序 ${todo.title}` : undefined}
        aria-hidden={!reorderEnabled || undefined}
        draggable={reorderEnabled}
        onDragStart={(event) => {
          if (!reorderEnabled) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-tododock-id", todo.id);
        }}
        onKeyDown={(event) => {
          if (!reorderEnabled || !event.altKey) return;
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onMove(todo, -1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onMove(todo, 1);
          }
        }}
      >
        <GripVertical size={15} />
      </span>
      <button
        type="button"
        className="check-button"
        aria-label={todo.status === "archived" ? `恢复归档 ${todo.title}` : todo.status === "completed" ? `恢复 ${todo.title}` : `完成 ${todo.title}`}
        aria-pressed={todo.status === "completed"}
        onClick={() => todo.status === "archived" ? onArchive(todo, false) : onToggle(todo)}
      >
        {todo.status === "completed" && <Check size={14} strokeWidth={3} />}
        {todo.status === "archived" && <ArchiveRestore size={13} />}
      </button>

      <button type="button" className="todo-content" onClick={() => onEdit(todo)}>
        <span className="todo-title-row">
          {todo.priority > 0 && <span className={`priority priority-${todo.priority}`}>P{todo.priority}</span>}
          <strong>{todo.title}</strong>
        </span>
        {todo.body && <div className="todo-body"><DeferredMarkdownBody markdown={todo.body} /></div>}
        {deadline && (
          <span className={`deadline ${overdue ? "is-overdue" : ""}`}>
            <CalendarClock size={15} />
            {deadline}
            {todo.reminderMinutes !== null && <Bell size={13} aria-label="已设置提醒" />}
          </span>
        )}
      </button>

      <div className="todo-actions">
        {reorderEnabled && (
          <span className="todo-reorder-actions">
            <IconButton label={`上移 ${todo.title}`} disabled={isFirst} onClick={() => onMove(todo, -1)}><ArrowUp size={14} /></IconButton>
            <IconButton label={`下移 ${todo.title}`} disabled={isLast} onClick={() => onMove(todo, 1)}><ArrowDown size={14} /></IconButton>
          </span>
        )}
        <IconButton label={`编辑 ${todo.title}`} onClick={() => onEdit(todo)}><Pencil size={15} /></IconButton>
        <IconButton
          label={todo.status === "archived" ? `恢复归档 ${todo.title}` : `归档 ${todo.title}`}
          onClick={() => onArchive(todo, todo.status !== "archived")}
        >
          {todo.status === "archived" ? <ArchiveRestore size={15} /> : <Archive size={15} />}
        </IconButton>
        <IconButton label={`删除 ${todo.title}`} onClick={() => onDelete(todo)}><Trash2 size={15} /></IconButton>
      </div>
    </article>
  );
}
