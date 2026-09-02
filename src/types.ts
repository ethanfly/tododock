export type TodoStatus = "open" | "completed" | "archived";

export type TodoPriority = 0 | 1 | 2 | 3;

export interface Todo {
  id: string;
  title: string;
  body: string;
  status: TodoStatus;
  priority: TodoPriority;
  deadlineAt: number | null;
  reminderMinutes: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sortOrder: number;
}

export interface CreateTodoInput {
  title: string;
  body: string;
  priority: TodoPriority;
  deadlineAt: number | null;
  reminderMinutes: number | null;
}

export interface UpdateTodoInput extends CreateTodoInput {
  id: string;
}

export type TodoFilter = "open" | "today" | "completed" | "archived";

export interface ListTodosInput {
  filter: TodoFilter;
  search: string;
}

export interface AppCapabilities {
  edgeSnap: boolean;
  edgeHide: boolean;
  globalShortcut: boolean;
  notifications: boolean;
  tray: boolean;
  reason: string | null;
}

export type DockEdge = "left" | "right" | "top";

export interface DockSnapshot {
  edge: DockEdge | null;
  hidden: boolean;
  autoHide: boolean;
  supported: boolean;
}

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePreference;
  globalShortcutEnabled: boolean;
  globalShortcut: string;
  createShortcut: string;
  autoHide: boolean;
  alwaysOnTop: boolean;
  defaultReminderMinutes: number;
  launchAtLogin: boolean;
  closeToTray: boolean;
  closeToTrayExplained: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  zentaoUrl: string;
  zentaoAccount: string;
  zentaoPassword: string;
  zentaoAssignedOnly: boolean;
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
}

export const MAX_TODO_BODY_CHARS = 1_000_000;
export const DEFAULT_LLM_ENDPOINT = "https://api.x.ai/v1";
export const DEFAULT_LLM_MODEL = "grok-4.5";

export interface LlmImageInput {
  mime: string;
  dataBase64: string;
}

export interface GeneratedTodoDraft {
  title: string;
  body: string;
  deadline: string | null;
}

export interface ZentaoSyncResult {
  created: number;
  updated: number;
  completed: number;
  skipped: number;
}

export interface DataFileResult {
  path: string;
  todoCount: number;
}

export interface ImportPreview {
  total: number;
  newCount: number;
  updateCount: number;
}

export interface RestorePreview {
  total: number;
  addCount: number;
  replaceCount: number;
  removeCount: number;
}

export interface DueReminder {
  todoId: string;
  kind: "upcoming" | "due";
  title: string;
  deadlineAt: number;
}
