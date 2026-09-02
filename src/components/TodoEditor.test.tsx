// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fromDateTimeLocal } from "../lib/date";
import type { Todo } from "../types";
import { TodoEditor } from "./TodoEditor";

const todo: Todo = {
  id: "01991a3b-e122-7fd0-a321-f4af72160cb8",
  title: "Reminder task",
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

afterEach(cleanup);

describe("TodoEditor", () => {
  it("saves an explicit deadline and per-todo reminder", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<TodoEditor todo={todo} defaultReminderMinutes={15} onClose={onClose} onSave={onSave} />);

    const deadline = "2030-01-02T10:30";
    fireEvent.change(screen.getByLabelText("截止时间"), { target: { value: deadline } });
    fireEvent.change(screen.getByLabelText("提醒"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: fromDateTimeLocal(deadline),
      reminderMinutes: 60,
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus inside the editor form", () => {
    render(
      <TodoEditor
        todo={todo}
        defaultReminderMinutes={15}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    const form = screen.getByRole("form", { name: "编辑待办" });
    const title = screen.getByLabelText("标题");
    const save = screen.getByRole("button", { name: "保存" });

    title.focus();
    fireEvent.keyDown(form, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    fireEvent.keyDown(form, { key: "Tab" });
    expect(document.activeElement).toBe(title);
  });

  it("restores focus to the control that opened the editor", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <TodoEditor
        todo={todo}
        defaultReminderMinutes={15}
        onClose={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(document.activeElement).toBe(screen.getByLabelText("标题"));
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
