// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditApp } from "./EditApp";
import * as api from "./lib/api";
import type { Todo } from "./types";

const todo: Todo = {
  id: "01991a3b-e122-7fd0-a321-f4af72160cb8",
  title: "Reminder task",
  body: "body",
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

afterEach(() => {
  cleanup();
  window.location.hash = "";
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
  window.location.hash = `#/edit/${todo.id}`;
});

describe("EditApp window", () => {
  it("loads a todo in an independent window and saves without a modal", async () => {
    vi.spyOn(api, "getTodo").mockResolvedValue(todo);
    const updateTodo = vi.spyOn(api, "updateTodo").mockResolvedValue({ ...todo, title: "Updated" });
    const closeWindow = vi.spyOn(api, "closeAuxiliaryWindow").mockResolvedValue(undefined);

    render(<EditApp />);
    const title = await waitFor(() => screen.getByLabelText("标题"));
    expect(title).toHaveValue("Reminder task");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".app-shell")).toHaveClass("is-aux-window");

    fireEvent.change(title, { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(expect.objectContaining({
      id: todo.id,
      title: "Updated",
    })));
    await waitFor(() => expect(closeWindow).toHaveBeenCalled());
  });

  it("shows an error when the edit hash has no todo id", async () => {
    window.location.hash = "#/edit";
    render(<EditApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("缺少待办 ID");
    expect(screen.queryByLabelText("标题")).toBeNull();
  });
});
