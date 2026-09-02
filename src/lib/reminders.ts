import type { DueReminder } from "../types";

const MAX_VISIBLE_REMINDERS = 20;

function key(reminder: DueReminder): string {
  return `${reminder.todoId}:${reminder.deadlineAt}:${reminder.kind}`;
}

export function mergeReminderAlerts(
  current: DueReminder[],
  incoming: DueReminder[],
): DueReminder[] {
  const merged = new Map(current.map((reminder) => [key(reminder), reminder]));
  for (const reminder of incoming) merged.set(key(reminder), reminder);
  return [...merged.values()]
    .sort((left, right) => right.deadlineAt - left.deadlineAt)
    .slice(0, MAX_VISIBLE_REMINDERS);
}

export function removeReminderAlerts(
  current: DueReminder[],
  handled: DueReminder[],
): DueReminder[] {
  const handledKeys = new Set(handled.map(key));
  return current.filter((reminder) => !handledKeys.has(key(reminder)));
}
