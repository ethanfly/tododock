import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CreateTodoDialog } from "./components/CreateTodoDialog";
import { preloadMarkdownEditor } from "./lib/preloadMarkdownEditor";
import { IconButton } from "./components/IconButton";
import { WindowChrome } from "./components/WindowChrome";
import {
  closeAuxiliaryWindow,
  createTodo,
  defaultAppSettings,
  generateTodosFromImages,
  getSettings,
  notifyTodosChanged,
  recordCaptureFocused,
} from "./lib/api";
import { capturedImageToLlmInput, type CapturedImage } from "./lib/clipboardImages";
import { fromDateTimeLocal } from "./lib/date";
import { isLlmConfigured } from "./lib/llm";
import { ensureNotificationPermission } from "./lib/notifications";
import type { AppSettings } from "./types";

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

export function CreateApp() {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  void preloadMarkdownEditor();

  useEffect(() => {
    void getSettings()
      .then((value) => {
        setSettings(value);
        document.documentElement.dataset.theme = value.theme;
      })
      .catch(() => undefined);
    void recordCaptureFocused().catch(() => undefined);
  }, []);

  async function onSubmit(items: Array<{ title: string; body: string; deadline: string }>) {
    if (submitting) return;
    setSubmitting(true);
    try {
      let notificationsReady = true;
      for (const item of items) {
        const deadlineAt = fromDateTimeLocal(item.deadline);
        const reminderMinutes = deadlineAt === null ? null : settings.defaultReminderMinutes;
        if (reminderMinutes !== null) {
          notificationsReady = await ensureNotificationPermission().catch(() => false) && notificationsReady;
        }
        await createTodo({
          title: item.title,
          body: item.body,
          priority: 0,
          deadlineAt,
          reminderMinutes,
        });
      }
      await notifyTodosChanged();
      if (!notificationsReady) {
        setError("Todo 已保存，但系统通知权限不可用；到期时只会在应用内显示状态。");
        setSubmitting(false);
        return;
      }
      await closeAuxiliaryWindow();
    } catch (cause) {
      setError(errorMessage(cause, "创建失败"));
      setSubmitting(false);
    }
  }

  async function onGenerateFromImages(images: CapturedImage[]) {
    return generateTodosFromImages(images.map(capturedImageToLlmInput));
  }

  return (
    <WindowChrome title="新建待办" closeLabel="关闭新建" bodyClassName="is-create-body" onClose={() => void closeAuxiliaryWindow()}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <IconButton label="关闭错误信息" onClick={() => setError(null)}><X size={14} /></IconButton>
        </div>
      )}
      <CreateTodoDialog
        submitting={submitting}
        titleInputRef={titleInputRef}
        llmEnabled={isLlmConfigured(settings)}
        onSubmit={onSubmit}
        onGenerateFromImages={onGenerateFromImages}
        onClose={() => void closeAuxiliaryWindow()}
      />
    </WindowChrome>
  );
}
