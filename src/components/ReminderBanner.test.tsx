// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReminderBanner } from "./ReminderBanner";

afterEach(cleanup);

describe("ReminderBanner", () => {
  it("shows a due reminder and exposes view and dismiss actions", () => {
    const onView = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReminderBanner
        reminders={[{
          todoId: "todo-1",
          kind: "due",
          title: "Ship release",
          deadlineAt: 1_900_000_000_000,
        }]}
        now={1_900_000_000_000}
        onView={onView}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("Ship release")).toBeTruthy();
    expect(screen.getByText("已到截止时间")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    fireEvent.click(screen.getByRole("button", { name: "忽略应用内提醒" }));
    expect(onView).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("summarizes multiple reminders", () => {
    render(
      <ReminderBanner
        reminders={[
          { todoId: "1", kind: "upcoming", title: "One", deadlineAt: 1 },
          { todoId: "2", kind: "due", title: "Two", deadlineAt: 2 },
        ]}
        now={3}
        onView={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText("2 项 Todo 需要关注")).toBeTruthy();
    expect(screen.getByText("One、Two")).toBeTruthy();
  });

  it("labels a missed upcoming reminder as overdue after resume", () => {
    render(
      <ReminderBanner
        reminders={[{
          todoId: "todo-2",
          kind: "upcoming",
          title: "Resume check",
          deadlineAt: 999,
        }]}
        now={1_000}
        onView={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByText("已到截止时间")).toBeTruthy();
  });
});
