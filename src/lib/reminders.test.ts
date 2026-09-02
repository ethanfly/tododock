import { describe, expect, it } from "vitest";

import type { DueReminder } from "../types";
import { mergeReminderAlerts, removeReminderAlerts } from "./reminders";

function reminder(index: number, kind: DueReminder["kind"] = "due"): DueReminder {
  return {
    todoId: `todo-${index}`,
    kind,
    title: `Reminder ${index}`,
    deadlineAt: index,
  };
}

describe("in-app reminder alerts", () => {
  it("deduplicates event and inbox delivery while keeping the newest 20", () => {
    const incoming = Array.from({ length: 22 }, (_, index) => reminder(index));
    const merged = mergeReminderAlerts([reminder(21)], incoming);
    expect(merged).toHaveLength(20);
    expect(merged[0]?.todoId).toBe("todo-21");
    expect(merged.at(-1)?.todoId).toBe("todo-2");
  });

  it("keeps upcoming and due alerts for the same deadline distinct", () => {
    const merged = mergeReminderAlerts([reminder(1, "upcoming")], [reminder(1, "due")]);
    expect(merged).toHaveLength(2);
  });

  it("removes acknowledged alerts without dropping a concurrent reminder", () => {
    const handled = [reminder(1), reminder(2)];
    const remaining = removeReminderAlerts([...handled, reminder(3)], handled);
    expect(remaining.map((item) => item.todoId)).toEqual(["todo-3"]);
  });
});
