import { BellRing, X } from "lucide-react";

import type { DueReminder } from "../types";
import { IconButton } from "./IconButton";

interface ReminderBannerProps {
  reminders: DueReminder[];
  now: number;
  onView: () => void;
  onDismiss: () => void;
}

export function ReminderBanner({ reminders, now, onView, onDismiss }: ReminderBannerProps) {
  const first = reminders[0];
  if (!first) return null;

  return (
    <div className="reminder-banner" role="alert">
      <BellRing size={17} />
      <div>
        <strong>{reminders.length > 1 ? `${reminders.length} 项 Todo 需要关注` : first.title}</strong>
        <span>
          {reminders.length > 1
            ? reminders.slice(0, 3).map((reminder) => reminder.title).join("、")
            : first.kind === "due" || first.deadlineAt <= now ? "已到截止时间" : "即将到期"}
        </span>
      </div>
      <button type="button" className="text-button" onClick={onView}>查看</button>
      <IconButton label="忽略应用内提醒" onClick={onDismiss}><X size={14} /></IconButton>
    </div>
  );
}
