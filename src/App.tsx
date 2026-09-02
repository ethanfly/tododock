import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Circle,
  Inbox,
  Minus,
  PanelTopClose,
  Pin,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CloseToTrayDialog } from "./components/CloseToTrayDialog";
import { IconButton } from "./components/IconButton";
import { ReminderBanner } from "./components/ReminderBanner";
import { TodoEditor } from "./components/TodoEditor";
import { TodoItem } from "./components/TodoItem";
import {
  acknowledgeCloseToTray,
  defaultAppSettings,
  deleteTodo,
  getCapabilities,
  getSettings,
  hideDockedWindow,
  isDesktopRuntime,
  listTodos,
  openAuxiliaryWindow,
  recordCaptureFocused,
  recordFrontendReady,
  reconcileWindowPosition,
  reorderTodos,
  revealDockedWindow,
  restoreTodo,
  saveSettings,
  setTodoArchived,
  setTodoCompleted,
  acknowledgeInAppReminders,
  listInAppReminders,
  updateTodo,
} from "./lib/api";
import { shortcutLabel } from "./lib/shortcut";
import { ensureNotificationPermission } from "./lib/notifications";
import { mergeReminderAlerts, removeReminderAlerts } from "./lib/reminders";
import type { AppCapabilities, AppSettings, DockEdge, DueReminder, Todo, TodoFilter, UpdateTodoInput } from "./types";

const filterLabels: Record<TodoFilter, string> = {
  open: "待办",
  today: "今天",
  completed: "已完成",
  archived: "已归档",
};

const todoPageSize = 100;

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = String(cause.message).trim();
    if (message) return message;
  }
  return fallback;
}

function App() {
  const undoDeleteTimerRef = useRef<number | undefined>(undefined);
  const listRequestVersionRef = useRef(0);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("open");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Todo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoDelete, setUndoDelete] = useState<Todo | null>(null);
  const [reminderAlerts, setReminderAlerts] = useState<DueReminder[]>([]);
  const [capabilities, setCapabilities] = useState<AppCapabilities | null>(null);
  const [autoHide, setAutoHide] = useState(true);
  const [dockedEdge, setDockedEdge] = useState<DockEdge | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [showCloseExplanation, setShowCloseExplanation] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const requestVersion = ++listRequestVersionRef.current;
    setLoadingMore(false);
    try {
      const items = await listTodos({ filter, search }, { limit: todoPageSize + 1, offset: 0 });
      if (requestVersion !== listRequestVersionRef.current) return;
      setTodos(items.slice(0, todoPageSize));
      setHasMore(items.length > todoPageSize);
      setError(null);
    } catch (cause) {
      if (requestVersion !== listRequestVersionRef.current) return;
      setError(errorMessage(cause, "无法读取 Todo"));
    } finally {
      if (requestVersion === listRequestVersionRef.current) setLoading(false);
    }
  }, [filter, search]);

  async function loadMoreTodos() {
    if (loadingMore || !hasMore) return;
    const requestVersion = ++listRequestVersionRef.current;
    setLoadingMore(true);
    try {
      const items = await listTodos(
        { filter, search },
        { limit: todoPageSize + 1, offset: todos.length },
      );
      if (requestVersion !== listRequestVersionRef.current) return;
      setTodos((current) => [...current, ...items.slice(0, todoPageSize)]);
      setHasMore(items.length > todoPageSize);
    } catch (cause) {
      if (requestVersion !== listRequestVersionRef.current) return;
      setError(errorMessage(cause, "无法读取更多 Todo"));
    } finally {
      if (requestVersion === listRequestVersionRef.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), search ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, search]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void recordFrontendReady().catch(() => undefined);
    void getCapabilities().then(setCapabilities).catch(() => undefined);
    void getSettings()
      .then((value) => {
        setSettings(value);
        setAutoHide(value.autoHide);
        setPinned(value.alwaysOnTop);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => () => window.clearTimeout(undoDeleteTimerRef.current), []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;

    const drainReminders = async () => {
      const pending = await listInAppReminders();
      if (!disposed) setReminderAlerts((current) => mergeReminderAlerts(current, pending));
    };

    void (async () => {
      removeListener = await listen("tododock://reminders-ready", () => {
        void drainReminders().catch((cause) => {
          if (!disposed) setError(errorMessage(cause, "无法读取应用内提醒"));
        });
      });
      if (disposed) {
        removeListener();
        return;
      }
      await drainReminders();
    })().catch((cause) => {
      if (!disposed) setError(errorMessage(cause, "无法读取应用内提醒"));
    });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const appWindow = getCurrentWindow();
    let moveTimer: number | undefined;
    let hideTimer: number | undefined;
    let disposed = false;

    const reconcileGeometry = () => {
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(() => {
        void reconcileWindowPosition()
          .then((snapshot) => {
            if (!disposed) setDockedEdge(snapshot.edge);
          })
          .catch(() => undefined);
      }, 180);
    };
    const removeMoved = appWindow.onMoved(reconcileGeometry);
    const removeResized = appWindow.onResized(reconcileGeometry);
    const removeScaleChanged = appWindow.onScaleChanged(reconcileGeometry);
    const removeFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      window.clearTimeout(hideTimer);
      if (!focused && autoHide && dockedEdge && !editing) {
        hideTimer = window.setTimeout(() => {
          void hideDockedWindow().catch(() => undefined);
        }, 700);
      }
    });
    const revealOnPointer = () => {
      if (!dockedEdge) return;
      void revealDockedWindow().catch(() => undefined);
    };
    document.addEventListener("pointerenter", revealOnPointer);
    void reconcileWindowPosition()
      .then((snapshot) => {
        if (!disposed) setDockedEdge(snapshot.edge);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      window.clearTimeout(moveTimer);
      window.clearTimeout(hideTimer);
      document.removeEventListener("pointerenter", revealOnPointer);
      void removeMoved.then((remove) => remove());
      void removeResized.then((remove) => remove());
      void removeScaleChanged.then((remove) => remove());
      void removeFocus.then((remove) => remove());
    };
  }, [autoHide, dockedEdge, editing]);

  const openCreate = useCallback(() => {
    void openAuxiliaryWindow("create").catch((cause) => {
      setError(errorMessage(cause, "无法打开新建窗口"));
    });
    void recordCaptureFocused().catch(() => undefined);
  }, []);
  const openSettings = useCallback(() => {
    void openAuxiliaryWindow("settings").catch((cause) => {
      setError(errorMessage(cause, "无法打开设置窗口"));
    });
  }, []);

  useEffect(() => {
    const focusCapture = () => openCreate();
    const showToday = () => {
      setSearch("");
      setFilter("today");
    };
    const showSettings = () => openSettings();
    const reloadSettings = () => {
      void getSettings()
        .then((value) => {
          setSettings(value);
          setAutoHide(value.autoHide);
          setPinned(value.alwaysOnTop);
        })
        .catch(() => undefined);
    };
    window.addEventListener("tododock:focus-capture", focusCapture);
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith("tododock:")) {
        void refresh();
        reloadSettings();
      }
    };
    window.addEventListener("storage", onStorage);
    const removeDesktopListeners = isDesktopRuntime()
      ? Promise.all([
        listen("tododock://focus-capture", focusCapture),
        listen("tododock://show-today", showToday),
        listen("tododock://show-settings", showSettings),
        listen("tododock://todos-changed", () => { void refresh(); }),
        listen("tododock://settings-changed", reloadSettings),
        listen("tododock://explain-close-to-tray", () => setShowCloseExplanation(true)),
      ])
      : Promise.resolve([() => undefined]);
    return () => {
      window.removeEventListener("tododock:focus-capture", focusCapture);
      window.removeEventListener("storage", onStorage);
      void removeDesktopListeners.then((removers) => removers.forEach((remove) => remove()));
    };
  }, [openCreate, openSettings, refresh]);

  const counts = useMemo(() => ({
    visible: todos.length,
    urgent: todos.filter((todo) => todo.deadlineAt !== null && todo.deadlineAt < now + 86_400_000).length,
  }), [now, todos]);

  async function toggleTodo(todo: Todo) {
    try {
      await setTodoCompleted(todo.id, todo.status !== "completed");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, "更新失败"));
    }
  }

  async function archiveTodo(todo: Todo, archived: boolean) {
    try {
      await setTodoArchived(todo.id, archived);
      await refresh();
      setNotice(archived ? `已归档“${todo.title}”` : `已将“${todo.title}”恢复到待办`);
    } catch (cause) {
      setError(errorMessage(cause, archived ? "归档失败" : "恢复归档失败"));
    }
  }

  async function persistTodoOrder(next: Todo[]) {
    setTodos(next);
    try {
      await reorderTodos(next.map((todo) => todo.id));
    } catch (cause) {
      setError(errorMessage(cause, "无法保存 Todo 顺序"));
      await refresh();
    }
  }

  function moveTodo(todo: Todo, direction: -1 | 1) {
    const index = todos.findIndex((item) => item.id === todo.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= todos.length) return;
    const next = [...todos];
    [next[index], next[target]] = [next[target], next[index]];
    void persistTodoOrder(next);
  }

  function dropTodo(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const dragged = todos.find((todo) => todo.id === draggedId);
    if (!dragged) return;
    const next = todos.filter((todo) => todo.id !== draggedId);
    const target = next.findIndex((todo) => todo.id === targetId);
    if (target < 0) return;
    next.splice(target, 0, dragged);
    void persistTodoOrder(next);
  }

  async function saveTodo(input: UpdateTodoInput) {
    try {
      const notificationsReady = input.reminderMinutes !== null
        ? await ensureNotificationPermission().catch(() => false)
        : true;
      await updateTodo(input);
      await refresh();
      if (!notificationsReady) {
        setError("Todo 已保存，但系统通知权限不可用；请在系统设置中允许 TodoDock 通知。");
      }
    } catch (cause) {
      setError(errorMessage(cause, "保存失败"));
      throw cause;
    }
  }

  async function removeTodo(todo: Todo) {
    try {
      await deleteTodo(todo.id);
      await refresh();
      window.clearTimeout(undoDeleteTimerRef.current);
      setUndoDelete(todo);
      undoDeleteTimerRef.current = window.setTimeout(() => setUndoDelete(null), 8_000);
    } catch (cause) {
      setError(errorMessage(cause, "删除失败"));
    }
  }

  async function undoRemovedTodo() {
    if (!undoDelete) return;
    try {
      await restoreTodo(undoDelete.id);
      window.clearTimeout(undoDeleteTimerRef.current);
      setUndoDelete(null);
      await refresh();
      setNotice(`已恢复“${undoDelete.title}”`);
    } catch (cause) {
      setError(errorMessage(cause, "无法撤销删除"));
    }
  }

  async function acknowledgeAndHide() {
    try {
      const saved = await acknowledgeCloseToTray();
      setSettings(saved);
      setShowCloseExplanation(false);
    } catch (cause) {
      setError(errorMessage(cause, "无法隐藏到托盘"));
    }
  }

  async function togglePinned() {
    const next = !pinned;
    try {
      const saved = await saveSettings({ ...settings, alwaysOnTop: next });
      setSettings(saved);
      setPinned(saved.alwaysOnTop);
    } catch (cause) {
      setError(errorMessage(cause, "无法切换置顶状态"));
    }
  }

  async function acknowledgeReminderAlerts() {
    const handled = reminderAlerts;
    if (handled.length === 0) return;
    try {
      await acknowledgeInAppReminders(handled);
      const remaining = await listInAppReminders();
      setReminderAlerts((current) => mergeReminderAlerts(
        removeReminderAlerts(current, handled),
        remaining,
      ));
    } catch (cause) {
      setError(errorMessage(cause, "无法确认应用内提醒"));
    }
  }

  function viewReminderAlerts() {
    const reminder = reminderAlerts[0];
    if (!reminder) return;
    setFilter("open");
    setSearch(reminderAlerts.length === 1 ? reminder.title : "");
    void acknowledgeReminderAlerts();
  }

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark"><Sparkles size={15} /></span>
          <span>TodoDock</span>
        </div>
        <div className="window-actions">
          <IconButton label={pinned ? "取消置顶" : "置顶窗口"} active={pinned} onClick={() => void togglePinned()}>
            <Pin size={15} />
          </IconButton>
          <IconButton label="最小化" onClick={() => isDesktopRuntime() && void getCurrentWindow().minimize()}>
            <Minus size={16} />
          </IconButton>
          <IconButton
            label={capabilities?.tray === false ? "当前环境没有系统托盘" : "隐藏到托盘"}
            disabled={capabilities?.tray === false}
            onClick={() => isDesktopRuntime() && void getCurrentWindow().hide()}
          >
            <PanelTopClose size={15} />
          </IconButton>
        </div>
      </header>

      <section className="workspace">
        <div className="hero-row">
          <div>
            <span className="eyebrow">待办列表</span>
            <h1>{filterLabels[filter]}</h1>
          </div>
          <div className="hero-actions">
            <button type="button" className="primary-button compact" onClick={openCreate}>
              <Plus size={15} />新建待办
            </button>
            <IconButton label="设置" onClick={openSettings}>
              <Settings2 size={17} />
            </IconButton>
          </div>
        </div>

        <nav className="filter-bar" aria-label="Todo 筛选">
          {(["open", "today", "completed", "archived"] as TodoFilter[]).map((value) => {
            const Icon = value === "open" ? Inbox : value === "today" ? CalendarDays : value === "completed" ? CheckCircle2 : Archive;
            return (
              <button
                key={value}
                type="button"
                className={filter === value ? "is-active" : ""}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                <Icon size={15} />
                {filterLabels[value]}
              </button>
            );
          })}
          <span className="filter-spacer" />
          <span className="filter-count">{counts.visible}{hasMore ? "+" : ""}</span>
        </nav>

        <div className="search-row">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或备注" aria-label="搜索 Todo" />
          {search && <IconButton label="清空搜索" onClick={() => setSearch("")}><X size={14} /></IconButton>}
        </div>

        {reminderAlerts.length > 0 && (
          <ReminderBanner
            reminders={reminderAlerts}
            now={now}
            onView={viewReminderAlerts}
            onDismiss={() => void acknowledgeReminderAlerts()}
          />
        )}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <IconButton label="关闭错误信息" onClick={() => setError(null)}><X size={14} /></IconButton>
          </div>
        )}

        {notice && (
          <div className="notice-banner" role="status">
            <span>{notice}</span>
            <IconButton label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></IconButton>
          </div>
        )}

        {undoDelete && (
          <div className="notice-banner undo-banner" role="status">
            <span>已将“{undoDelete.title}”移入回收状态</span>
            <button type="button" className="text-button" onClick={() => void undoRemovedTodo()}>撤销</button>
          </div>
        )}

        <section className="todo-list" aria-busy={loading || loadingMore} aria-live="polite">
          {loading ? (
            <div className="empty-state"><span className="skeleton-line" /><span className="skeleton-line short" /></div>
          ) : todos.length === 0 ? (
            <div className="empty-state">
              <span className="empty-orbit"><Circle size={26} /></span>
              <strong>{search ? "没有匹配的 Todo" : filter === "completed" ? "还没有完成记录" : filter === "archived" ? "归档中还没有内容" : "此刻很清爽"}</strong>
              <p>{search ? "换个关键词试试。" : "点击新建待办，或按下全局快捷键捕捉下一件事。"}</p>
            </div>
          ) : (
            todos.map((todo, index) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                now={now}
                onToggle={(item) => void toggleTodo(item)}
                onArchive={(item, archived) => void archiveTodo(item, archived)}
                onEdit={setEditing}
                onDelete={(item) => void removeTodo(item)}
                reorderEnabled={filter === "open" && search === ""}
                isFirst={index === 0}
                isLast={index === todos.length - 1}
                onMove={moveTodo}
                onDrop={dropTodo}
              />
            ))
          )}
          {!loading && hasMore && (
            <button type="button" className="load-more-button" onClick={() => void loadMoreTodos()} disabled={loadingMore}>
              {loadingMore ? "正在载入…" : "载入更多"}
            </button>
          )}
        </section>
      </section>

      <footer className="statusbar">
        <span><span className="status-dot" />本地存储</span>
        {counts.urgent > 0 && <span>{counts.urgent}{hasMore ? "+" : ""} 项临近</span>}
        <span className="status-spacer" />
        {dockedEdge && <span>已贴{dockedEdge === "left" ? "左侧" : dockedEdge === "right" ? "右侧" : "顶部"}</span>}
        {settings.globalShortcutEnabled ? (
          <>
            <kbd>{shortcutLabel(settings.createShortcut)}</kbd>
            <kbd>{shortcutLabel(settings.globalShortcut)}</kbd>
          </>
        ) : (
          <kbd>快捷键已关闭</kbd>
        )}
      </footer>

      {editing && (
        <TodoEditor
          todo={editing}
          defaultReminderMinutes={settings.defaultReminderMinutes}
          onClose={() => setEditing(null)}
          onSave={saveTodo}
        />
      )}

      {showCloseExplanation && (
        <CloseToTrayDialog
          onHide={() => void acknowledgeAndHide()}
          onCancel={() => setShowCloseExplanation(false)}
          onOpenSettings={() => {
            setShowCloseExplanation(false);
            openSettings();
          }}
        />
      )}
    </main>
  );
}

export default App;
