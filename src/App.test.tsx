// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import * as api from "./lib/api";
import type { Todo } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function todo(id: string, title: string): Todo {
  return {
    id,
    title,
    body: "",
    status: "open",
    priority: 0,
    deadlineAt: null,
    reminderMinutes: null,
    completedAt: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    sortOrder: 1024,
  };
}

describe("home layout", () => {
  it("keeps the list on home and opens create/settings as new windows", async () => {
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建待办" })).toBeInTheDocument());

    expect(screen.queryByLabelText("禅道地址")).toBeNull();
    expect(screen.queryByLabelText("待办内容")).toBeNull();
    expect(screen.queryByLabelText("快速记录 Todo")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索 Todo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建待办" }));
    await waitFor(() => expect(opened.some((url) => url.includes("#/create"))).toBe(true));
    expect(screen.queryByLabelText("待办内容")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(opened.some((url) => url.includes("#/settings"))).toBe(true));
    expect(screen.queryByLabelText("主题")).toBeNull();
    expect(screen.queryByLabelText("禅道地址")).toBeNull();
    expect(screen.queryByRole("button", { name: "同步禅道" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索 Todo" })).toBeInTheDocument();
  });

  it("opens the create window from tododock:focus-capture", async () => {
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建待办" })).toBeInTheDocument());
    window.dispatchEvent(new Event("tododock:focus-capture"));
    await waitFor(() => expect(opened.some((url) => url.includes("#/create"))).toBe(true));
    expect(screen.queryByLabelText("待办内容")).toBeNull();
  });
});

describe("App list loading", () => {
  it("ignores a stale search response after a newer query starts", async () => {
    const initial = deferred<Todo[]>();
    const newer = deferred<Todo[]>();
    const listTodos = vi.spyOn(api, "listTodos").mockImplementation(({ search }) => (
      search === "new" ? newer.promise : initial.promise
    ));

    render(<App />);
    const search = screen.getByRole("textbox", { name: "搜索 Todo" });
    fireEvent.change(search, { target: { value: "new" } });

    await waitFor(() => {
      expect(listTodos.mock.calls.some(([input]) => input.search === "new")).toBe(true);
    });

    newer.resolve([todo("01991a3b-e122-7fd0-a321-f4af72160cb8", "Newest result")]);
    await waitFor(() => expect(screen.getByText("Newest result")).toBeInTheDocument());

    initial.resolve([todo("01991a3b-e122-7fd0-a321-f4af72160cb9", "Stale result")]);
    await waitFor(() => expect(screen.queryByText("Stale result")).not.toBeInTheDocument());
    expect(screen.getByText("Newest result")).toBeInTheDocument();
  });
});
