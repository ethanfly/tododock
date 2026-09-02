import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { TodoEditor } from "./components/TodoEditor";
import { IconButton } from "./components/IconButton";
import { WindowChrome } from "./components/WindowChrome";
import {
  closeAuxiliaryWindow,
  defaultAppSettings,
  getSettings,
  getTodo,
  notifyTodosChanged,
  updateTodo,
} from "./lib/api";
import { ensureNotificationPermission } from "./lib/notifications";
import { preloadMarkdownEditor } from "./lib/preloadMarkdownEditor";
import { getEditTodoId } from "./lib/windowView";
import type { AppSettings, Todo, UpdateTodoInput } from "./types";

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

export function EditApp() {
  const todoId = getEditTodoId();
  const [todo, setTodo] = useState<Todo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [error, setError] = useState<string | null>(() => todoId ? null : "缺少待办 ID");
  const [loading, setLoading] = useState(() => Boolean(todoId));
  void preloadMarkdownEditor();

  useEffect(() => {
    let disposed = false;
    void getSettings()
      .then((value) => {
        if (disposed) return;
        setSettings(value);
        document.documentElement.dataset.theme = value.theme;
      })
      .catch(() => undefined);
    if (!todoId) return;
    void getTodo(todoId)
      .then((value) => {
        if (disposed) return;
        setTodo(value);
        setError(null);
      })
      .catch((cause) => {
        if (disposed) return;
        setTodo(null);
        setError(errorMessage(cause, "无法读取待办"));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [todoId]);

  async function onSave(input: UpdateTodoInput) {
    if (input.reminderMinutes !== null) {
      await ensureNotificationPermission().catch(() => false);
    }
    await updateTodo(input);
    await notifyTodosChanged();
    await closeAuxiliaryWindow();
  }

  return (
    <WindowChrome title="编辑待办" closeLabel="关闭编辑" bodyClassName="is-create-body" onClose={() => void closeAuxiliaryWindow()}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <IconButton label="关闭错误信息" onClick={() => setError(null)}><X size={14} /></IconButton>
        </div>
      )}
      {loading && <p className="field-hint">正在载入待办…</p>}
      {!loading && todo && (
        <TodoEditor
          todo={todo}
          defaultReminderMinutes={settings.defaultReminderMinutes}
          onClose={() => void closeAuxiliaryWindow()}
          onSave={onSave}
        />
      )}
    </WindowChrome>
  );
}
