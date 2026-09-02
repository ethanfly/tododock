import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import type {
  AppCapabilities,
  AppSettings,
  CreateTodoInput,
  DataFileResult,
  DockSnapshot,
  DueReminder,
  ListTodosInput,
  GeneratedTodoDraft,
  ImportPreview,
  LlmImageInput,
  RestorePreview,
  Todo,
  UpdateTodoInput,
  ZentaoSyncResult,
} from "../types";

const todoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["open", "completed", "archived"]),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  deadlineAt: z.number().nullable(),
  reminderMinutes: z.number().int().nullable(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sortOrder: z.number(),
});

const capabilitiesSchema = z.object({
  edgeSnap: z.boolean(),
  edgeHide: z.boolean(),
  globalShortcut: z.boolean(),
  notifications: z.boolean(),
  tray: z.boolean().default(true),
  reason: z.string().nullable(),
});

const dockSnapshotSchema = z.object({
  edge: z.enum(["left", "right", "top"]).nullable(),
  hidden: z.boolean(),
  autoHide: z.boolean(),
  supported: z.boolean(),
});

const appSettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  globalShortcutEnabled: z.boolean().default(true),
  globalShortcut: z.string().default("Alt+Space"),
  createShortcut: z.string().default("Control+Alt+KeyQ"),
  autoHide: z.boolean(),
  alwaysOnTop: z.boolean(),
  defaultReminderMinutes: z.number().int(),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  closeToTrayExplained: z.boolean().default(false),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  zentaoUrl: z.string().default(""),
  zentaoAccount: z.string().default(""),
  zentaoPassword: z.string().default(""),
  zentaoAssignedOnly: z.boolean().default(true),
  llmEndpoint: z.string().default("https://api.x.ai/v1"),
  llmApiKey: z.string().default(""),
  llmModel: z.string().default("grok-4.5"),
});

const generatedTodoDraftSchema = z.object({
  title: z.string(),
  body: z.string().default(""),
  deadline: z.string().nullable().default(null),
});

const zentaoSyncResultSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const dataFileResultSchema = z.object({
  path: z.string(),
  todoCount: z.number().int().nonnegative(),
});

const importPreviewSchema = z.object({
  total: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  updateCount: z.number().int().nonnegative(),
});

const dueReminderSchema = z.object({
  todoId: z.string(),
  kind: z.enum(["upcoming", "due"]),
  title: z.string(),
  deadlineAt: z.number(),
});

const restorePreviewSchema = z.object({
  total: z.number().int().nonnegative(),
  addCount: z.number().int().nonnegative(),
  replaceCount: z.number().int().nonnegative(),
  removeCount: z.number().int().nonnegative(),
});

export const defaultAppSettings: AppSettings = {
  theme: "system",
  globalShortcutEnabled: true,
  globalShortcut: "Alt+Space",
  createShortcut: "Control+Alt+KeyQ",
  autoHide: true,
  alwaysOnTop: false,
  defaultReminderMinutes: 15,
  launchAtLogin: false,
  closeToTray: true,
  closeToTrayExplained: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  zentaoUrl: "",
  zentaoAccount: "",
  zentaoPassword: "",
  zentaoAssignedOnly: true,
  llmEndpoint: "https://api.x.ai/v1",
  llmApiKey: "",
  llmModel: "grok-4.5",
};

const browserStorageKey = "tododock:browser-preview";
const browserTrashKey = "tododock:browser-preview-trash";
const browserSettingsKey = "tododock:browser-preview-settings";

function isImeConflictingCreateShortcut(shortcut: string): boolean {
  return ["Control+Space", "Ctrl+Space", "CommandOrControl+Space", "CommandOrCtrl+Space"].includes(shortcut);
}

function readBrowserSettings(): AppSettings {
  const value = localStorage.getItem(browserSettingsKey);
  if (!value) return { ...defaultAppSettings };
  try {
    const parsed = appSettingsSchema.parse({ ...defaultAppSettings, ...JSON.parse(value) });
    if (!isImeConflictingCreateShortcut(parsed.createShortcut)) return parsed;
    return { ...parsed, createShortcut: defaultAppSettings.createShortcut };
  } catch {
    localStorage.removeItem(browserSettingsKey);
    return { ...defaultAppSettings };
  }
}

function writeBrowserSettings(settings: AppSettings): void {
  localStorage.setItem(browserSettingsKey, JSON.stringify(settings));
}

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function readBrowserTodos(): Todo[] {
  const value = localStorage.getItem(browserStorageKey);
  if (!value) return [];

  try {
    return z.array(todoSchema).parse(JSON.parse(value));
  } catch {
    localStorage.removeItem(browserStorageKey);
    return [];
  }
}

function writeBrowserTodos(todos: Todo[]): void {
  localStorage.setItem(browserStorageKey, JSON.stringify(todos));
}

function readBrowserTrash(): Todo[] {
  const value = localStorage.getItem(browserTrashKey);
  if (!value) return [];
  try {
    return z.array(todoSchema).parse(JSON.parse(value));
  } catch {
    localStorage.removeItem(browserTrashKey);
    return [];
  }
}

function writeBrowserTrash(todos: Todo[]): void {
  localStorage.setItem(browserTrashKey, JSON.stringify(todos));
}

function matchesBrowserFilter(todo: Todo, input: ListTodosInput): boolean {
  if (input.filter === "completed" && todo.status !== "completed") return false;
  if (input.filter === "archived" && todo.status !== "archived") return false;
  if (input.filter !== "completed" && input.filter !== "archived" && todo.status !== "open") return false;

  if (input.filter === "today") {
    if (todo.deadlineAt === null) return false;
    const now = new Date();
    const endOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    ).getTime();
    if (todo.deadlineAt > endOfDay) return false;
  }

  const search = input.search.trim().toLocaleLowerCase();
  return (
    !search ||
    todo.title.toLocaleLowerCase().includes(search) ||
    todo.body.toLocaleLowerCase().includes(search)
  );
}

export async function getTodo(id: string): Promise<Todo> {
  if (!todoSchema.shape.id.safeParse(id).success) throw new Error("Todo ID 无效");
  if (inTauri()) {
    return todoSchema.parse(await invoke("get_todo", { id }));
  }
  const todo = readBrowserTodos().find((item) => item.id === id);
  if (!todo) throw new Error("Todo 不存在或已被删除");
  return todoSchema.parse(todo);
}

export async function listTodos(
  input: ListTodosInput,
  pagination: { limit: number; offset: number } = { limit: 500, offset: 0 },
): Promise<Todo[]> {
  if (inTauri()) {
    return z.array(todoSchema).parse(await invoke("list_todos", { input, ...pagination }));
  }

  return readBrowserTodos()
    .filter((todo) => matchesBrowserFilter(todo, input))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .slice(pagination.offset, pagination.offset + pagination.limit);
}

export async function createTodo(input: CreateTodoInput): Promise<Todo> {
  if (inTauri()) {
    return todoSchema.parse(await invoke("create_todo", { input }));
  }

  const todos = readBrowserTodos();
  const now = Date.now();
  const todo: Todo = {
    id: crypto.randomUUID(),
    ...input,
    status: "open",
    completedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    sortOrder: todos.reduce((maximum, item) => Math.max(maximum, item.sortOrder), 0) + 1,
  };
  writeBrowserTodos([...todos, todo]);
  return todo;
}

export async function updateTodo(input: UpdateTodoInput): Promise<Todo> {
  if (inTauri()) {
    return todoSchema.parse(await invoke("update_todo", { input }));
  }

  const todos = readBrowserTodos();
  const index = todos.findIndex((todo) => todo.id === input.id);
  if (index < 0) throw new Error("Todo 不存在或已被删除");
  const next = { ...todos[index], ...input, updatedAt: Date.now() };
  todos[index] = next;
  writeBrowserTodos(todos);
  return todoSchema.parse(next);
}

export async function setTodoCompleted(id: string, completed: boolean): Promise<Todo> {
  if (inTauri()) {
    return todoSchema.parse(await invoke("set_todo_completed", { id, completed }));
  }

  const todos = readBrowserTodos();
  const index = todos.findIndex((todo) => todo.id === id);
  if (index < 0) throw new Error("Todo 不存在或已被删除");
  const now = Date.now();
  const next: Todo = {
    ...todos[index],
    status: completed ? "completed" : "open",
    completedAt: completed ? now : null,
    archivedAt: null,
    updatedAt: now,
  };
  todos[index] = next;
  writeBrowserTodos(todos);
  return next;
}

export async function setTodoArchived(id: string, archived: boolean): Promise<Todo> {
  if (inTauri()) {
    return todoSchema.parse(await invoke("set_todo_archived", { id, archived }));
  }

  const todos = readBrowserTodos();
  const index = todos.findIndex((todo) => todo.id === id);
  if (index < 0) throw new Error("Todo 不存在或已被删除");
  const now = Date.now();
  const next: Todo = {
    ...todos[index],
    status: archived ? "archived" : "open",
    archivedAt: archived ? now : null,
    completedAt: null,
    updatedAt: now,
  };
  todos[index] = next;
  writeBrowserTodos(todos);
  return next;
}

export async function reorderTodos(ids: string[]): Promise<void> {
  if (inTauri()) {
    await invoke("reorder_todos", { ids });
    return;
  }
  const order = new Map(ids.map((id, index) => [id, (index + 1) * 1024]));
  const now = Date.now();
  const todos = readBrowserTodos();
  if (ids.some((id) => !todos.some((todo) => todo.id === id && todo.status === "open"))) {
    throw new Error("只能排序当前未删除的待办 Todo");
  }
  writeBrowserTodos(todos.map((todo) => {
    const sortOrder = order.get(todo.id);
    return sortOrder === undefined ? todo : { ...todo, sortOrder, updatedAt: now };
  }));
}

export async function deleteTodo(id: string): Promise<void> {
  if (inTauri()) {
    await invoke("delete_todo", { id });
    return;
  }
  const todos = readBrowserTodos();
  const deleted = todos.find((todo) => todo.id === id);
  if (!deleted) throw new Error("Todo 不存在或已被删除");
  writeBrowserTodos(todos.filter((todo) => todo.id !== id));
  writeBrowserTrash([...readBrowserTrash().filter((todo) => todo.id !== id), deleted]);
}

export async function restoreTodo(id: string): Promise<Todo> {
  if (inTauri()) {
    return todoSchema.parse(await invoke("restore_todo", { id }));
  }
  const trash = readBrowserTrash();
  const todo = trash.find((item) => item.id === id);
  if (!todo) throw new Error("Todo 不存在或未被删除");
  const restored = { ...todo, updatedAt: Date.now() };
  writeBrowserTodos([...readBrowserTodos(), restored]);
  writeBrowserTrash(trash.filter((item) => item.id !== id));
  return todoSchema.parse(restored);
}

export async function purgeDeletedTodos(): Promise<number> {
  if (inTauri()) {
    return z.number().int().nonnegative().parse(await invoke("purge_deleted_todos"));
  }
  const deleted = readBrowserTrash().length;
  writeBrowserTrash([]);
  return deleted;
}

export async function getCapabilities(): Promise<AppCapabilities> {
  if (inTauri()) {
    return capabilitiesSchema.parse(await invoke("get_capabilities"));
  }
  return {
    edgeSnap: false,
    edgeHide: false,
    globalShortcut: false,
    notifications: false,
    tray: false,
    reason: "浏览器预览不提供桌面系统能力",
  };
}

export function isDesktopRuntime(): boolean {
  return inTauri();
}

export type AuxiliaryWindowKind = "create" | "settings" | "edit";

export async function openAuxiliaryWindow(kind: AuxiliaryWindowKind, id?: string): Promise<void> {
  if (kind === "edit") {
    if (!id) throw new Error("缺少待办 ID");
    if (!todoSchema.shape.id.safeParse(id).success) throw new Error("Todo ID 无效");
  } else if (kind !== "create" && kind !== "settings") {
    throw new Error("未知窗口");
  }
  if (inTauri()) {
    await invoke("open_auxiliary_window", { kind, id: id ?? null });
    return;
  }
  const url = new URL(window.location.href);
  url.hash = kind === "edit" && id ? `/edit/${id}` : `/${kind}`;
  const features = kind === "settings"
    ? "popup=yes,width=440,height=680"
    : "popup=yes,width=420,height=640";
  const name = kind === "edit" && id ? `tododock-edit-${id}` : `tododock-${kind}`;
  window.open(url.toString(), name, features)?.focus();
}

export async function closeAuxiliaryWindow(): Promise<void> {
  if (inTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  window.close();
}

export async function notifyTodosChanged(): Promise<void> {
  if (!inTauri()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit("tododock://todos-changed");
}

export async function notifySettingsChanged(): Promise<void> {
  if (!inTauri()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit("tododock://settings-changed");
}

const browserDockSnapshot: DockSnapshot = {
  edge: null,
  hidden: false,
  autoHide: false,
  supported: false,
};

export async function snapWindow(): Promise<DockSnapshot> {
  if (!inTauri()) return browserDockSnapshot;
  return dockSnapshotSchema.parse(await invoke("snap_window"));
}

export async function reconcileWindowPosition(): Promise<DockSnapshot> {
  if (!inTauri()) return browserDockSnapshot;
  return dockSnapshotSchema.parse(await invoke("reconcile_window_position"));
}

export async function hideDockedWindow(): Promise<DockSnapshot> {
  if (!inTauri()) return browserDockSnapshot;
  return dockSnapshotSchema.parse(await invoke("hide_docked_window"));
}

export async function revealDockedWindow(): Promise<DockSnapshot> {
  if (!inTauri()) return browserDockSnapshot;
  return dockSnapshotSchema.parse(await invoke("reveal_docked_window"));
}

export async function setEdgeAutoHide(enabled: boolean): Promise<DockSnapshot> {
  if (!inTauri()) return browserDockSnapshot;
  return dockSnapshotSchema.parse(await invoke("set_edge_auto_hide", { enabled }));
}

export async function getSettings(): Promise<AppSettings> {
  if (!inTauri()) return readBrowserSettings();
  return appSettingsSchema.parse(await invoke("get_settings"));
}

export async function listInAppReminders(): Promise<DueReminder[]> {
  if (!inTauri()) return [];
  return z.array(dueReminderSchema).parse(await invoke("list_in_app_reminders"));
}

export async function acknowledgeInAppReminders(reminders: DueReminder[]): Promise<number> {
  if (!inTauri()) return reminders.length;
  return z.number().int().nonnegative().parse(await invoke("acknowledge_in_app_reminders", {
    reminders: reminders.map(({ todoId, kind, deadlineAt }) => ({ todoId, kind, deadlineAt })),
  }));
}

export async function recordFrontendReady(): Promise<number | null> {
  if (!inTauri()) return null;
  return z.number().int().nonnegative().parse(await invoke("record_frontend_ready"));
}

export async function recordCaptureFocused(): Promise<number | null> {
  if (!inTauri()) return null;
  return z.number().int().nonnegative().nullable().parse(await invoke("record_capture_focused"));
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  if (!inTauri()) {
    const next = appSettingsSchema.parse(settings);
    writeBrowserSettings(next);
    return next;
  }
  return appSettingsSchema.parse(await invoke("save_settings", { settings }));
}

export async function acknowledgeCloseToTray(): Promise<AppSettings> {
  if (!inTauri()) {
    const next = { ...readBrowserSettings(), closeToTrayExplained: true };
    writeBrowserSettings(next);
    return next;
  }
  return appSettingsSchema.parse(await invoke("acknowledge_close_to_tray"));
}

export async function exportData(): Promise<DataFileResult> {
  if (!inTauri()) throw new Error("浏览器预览不写入桌面导出目录");
  return dataFileResultSchema.parse(await invoke("export_data"));
}

export async function exportMarkdown(): Promise<DataFileResult> {
  if (!inTauri()) throw new Error("浏览器预览不写入桌面导出目录");
  return dataFileResultSchema.parse(await invoke("export_markdown"));
}

export async function getDataDirectory(): Promise<string> {
  if (!inTauri()) return "浏览器预览使用 localStorage";
  return z.string().parse(await invoke("get_data_directory"));
}

export async function exportDiagnostics(): Promise<string> {
  if (!inTauri()) throw new Error("浏览器预览不生成桌面诊断文件");
  return z.string().parse(await invoke("export_diagnostics"));
}

export async function backupData(): Promise<DataFileResult> {
  if (!inTauri()) throw new Error("浏览器预览不写入桌面备份目录");
  return dataFileResultSchema.parse(await invoke("backup_data"));
}

export async function previewImport(json: string): Promise<ImportPreview> {
  if (!inTauri()) throw new Error("浏览器预览不导入桌面数据");
  return importPreviewSchema.parse(await invoke("preview_import", { json }));
}

export async function importData(json: string): Promise<ImportPreview> {
  if (!inTauri()) throw new Error("浏览器预览不导入桌面数据");
  return importPreviewSchema.parse(await invoke("import_data", { json }));
}

export async function previewRestore(json: string): Promise<RestorePreview> {
  if (!inTauri()) throw new Error("浏览器预览不恢复桌面数据");
  return restorePreviewSchema.parse(await invoke("preview_restore", { json }));
}

export async function restoreData(json: string): Promise<RestorePreview> {
  if (!inTauri()) throw new Error("浏览器预览不恢复桌面数据");
  return restorePreviewSchema.parse(await invoke("restore_data", { json }));
}

export async function syncZentaoTasks(): Promise<ZentaoSyncResult> {
  if (!inTauri()) throw new Error("浏览器预览不同步禅道任务");
  return zentaoSyncResultSchema.parse(await invoke("sync_zentao_tasks"));
}

export async function generateTodosFromImages(images: LlmImageInput[]): Promise<GeneratedTodoDraft[]> {
  if (!inTauri()) throw new Error("浏览器预览不能调用大模型");
  return z.array(generatedTodoDraftSchema).parse(await invoke("generate_todos_from_images", { images }));
}
