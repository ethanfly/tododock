// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/" }



import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeCloseToTray,
  createTodo,
  defaultAppSettings,
  deleteTodo,
  getSettings,
  getTodo,
  listTodos,
  openAuxiliaryWindow,
  purgeDeletedTodos,
  reorderTodos,
  restoreTodo,
  saveSettings,
  setTodoArchived,
  setTodoCompleted,
  updateTodo,
} from "./api";

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, value); },
};

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

describe("browser preview Todo storage", () => {
  beforeEach(() => storage.clear());

  it("persists browser preview settings without dropping unrelated values", async () => {
    const saved = await saveSettings({
      ...defaultAppSettings,
      theme: "dark",
      defaultReminderMinutes: 45,
      globalShortcut: "CommandOrControl+Alt+T",
      createShortcut: "Control+Alt+KeyQ",
    });

    expect(await getSettings()).toEqual(saved);
    expect(saved.createShortcut).toBe("Control+Alt+KeyQ");
    expect(defaultAppSettings.createShortcut).toBe("Control+Alt+KeyQ");
    expect(defaultAppSettings.globalShortcut).toBe("Alt+Space");

    const explained = await acknowledgeCloseToTray();
    expect(explained.theme).toBe("dark");
    expect(explained.defaultReminderMinutes).toBe(45);
    expect(explained.closeToTrayExplained).toBe(true);
  });

  it("replaces a stored Ctrl+Space create shortcut that conflicts with IME", async () => {
    localStorage.setItem(
      "tododock:browser-preview-settings",
      JSON.stringify({ ...defaultAppSettings, createShortcut: "Control+Space" }),
    );
    expect((await getSettings()).createShortcut).toBe("Control+Alt+KeyQ");
  });

  it("creates, edits, searches, and completes todos locally", async () => {
    const created = await createTodo({
      title: "Local task",
      body: "**markdown**",
      priority: 1,
      deadlineAt: null,
      reminderMinutes: null,
    });
    expect((await listTodos({ filter: "open", search: "local" }))).toHaveLength(1);
    expect((await getTodo(created.id)).title).toBe("Local task");

    await updateTodo({
      id: created.id,
      title: "Updated task",
      body: "body",
      priority: 2,
      deadlineAt: null,
      reminderMinutes: null,
    });
    expect((await listTodos({ filter: "open", search: "updated" }))[0]?.priority).toBe(2);

    await setTodoCompleted(created.id, true);
    expect(await listTodos({ filter: "open", search: "" })).toHaveLength(0);
    expect(await listTodos({ filter: "completed", search: "" })).toHaveLength(1);
  });

  it("soft deletes and restores a todo in the preview", async () => {
    const created = await createTodo({
      title: "Undo me",
      body: "",
      priority: 0,
      deadlineAt: null,
      reminderMinutes: null,
    });
    await deleteTodo(created.id);
    expect(await listTodos({ filter: "open", search: "" })).toHaveLength(0);
    await restoreTodo(created.id);
    expect((await listTodos({ filter: "open", search: "" }))[0]?.title).toBe("Undo me");
  });

  it("archives, reorders, and permanently clears deleted preview todos", async () => {
    const first = await createTodo({
      title: "First",
      body: "",
      priority: 0,
      deadlineAt: null,
      reminderMinutes: null,
    });
    const second = await createTodo({
      title: "Second",
      body: "",
      priority: 0,
      deadlineAt: null,
      reminderMinutes: null,
    });

    await reorderTodos([second.id, first.id]);
    expect((await listTodos({ filter: "open", search: "" })).map((todo) => todo.title)).toEqual(["Second", "First"]);

    await setTodoArchived(first.id, true);
    expect(await listTodos({ filter: "open", search: "" })).toHaveLength(1);
    expect((await listTodos({ filter: "archived", search: "" }))[0]?.title).toBe("First");
    await setTodoArchived(first.id, false);

    await deleteTodo(first.id);
    expect(await purgeDeletedTodos()).toBe(1);
    await expect(restoreTodo(first.id)).rejects.toThrow("Todo 不存在或未被删除");
  });

  it("clears archive metadata when completing a preview todo", async () => {
    const created = await createTodo({
      title: "Archived then completed",
      body: "",
      priority: 0,
      deadlineAt: null,
      reminderMinutes: null,
    });
    const archived = await setTodoArchived(created.id, true);
    expect(archived.archivedAt).not.toBeNull();

    const completed = await setTodoCompleted(created.id, true);
    expect(completed.status).toBe("completed");
    expect(completed.archivedAt).toBeNull();
  });
});

describe("openAuxiliaryWindow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a separate browser window for create, settings, and edit", async () => {
    const opened: Array<{ url: string; name: string }> = [];
    vi.spyOn(window, "open").mockImplementation((url, name) => {
      opened.push({ url: String(url), name: String(name) });
      return null;
    });
    const todoId = "01991a3b-e122-7fd0-a321-f4af72160cb8";

    await openAuxiliaryWindow("create");
    await openAuxiliaryWindow("settings");
    await openAuxiliaryWindow("edit", todoId);

    expect(opened[0]?.url).toContain("#/create");
    expect(opened[0]?.name).toBe("tododock-create");
    expect(opened[1]?.url).toContain("#/settings");
    expect(opened[1]?.name).toBe("tododock-settings");
    expect(opened[2]?.url).toContain(`#/edit/${todoId}`);
    expect(opened[2]?.name).toBe(`tododock-edit-${todoId}`);
    await expect(openAuxiliaryWindow("edit")).rejects.toThrow("缺少待办 ID");
  });
});
