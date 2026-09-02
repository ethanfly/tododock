import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  buildDateTimeLocal,
  calendarCells,
  displayDateTimeLocal,
  normalizeDateTimeLocal,
  pad2,
  parseTimeValue,
} from "../lib/date";
import { DATE_POPOVER_INSET, placePopover } from "../lib/popoverPlacement";

interface DateTimePickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  mode?: "datetime" | "time";
  compact?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
const hours = Array.from({ length: 24 }, (_, index) => pad2(index));
const minutes = Array.from({ length: 12 }, (_, index) => pad2(index * 5));

function splitDateTime(value: string): { date: string; hours: string; minutes: string } {
  if (!value) {
    const now = new Date();
    return {
      date: buildDateTimeLocal(now.getFullYear(), now.getMonth() + 1, now.getDate(), 18, 0).slice(0, 10),
      hours: "18",
      minutes: "00",
    };
  }
  try {
    const normalized = normalizeDateTimeLocal(value);
    return {
      date: normalized.slice(0, 10),
      hours: normalized.slice(11, 13),
      minutes: normalized.slice(14, 16),
    };
  } catch {
    const now = new Date();
    return {
      date: buildDateTimeLocal(now.getFullYear(), now.getMonth() + 1, now.getDate(), 18, 0).slice(0, 10),
      hours: "18",
      minutes: "00",
    };
  }
}

export function DateTimePicker({
  id,
  value,
  onChange,
  mode = "datetime",
  compact = false,
  disabled = false,
  "aria-label": ariaLabel,
}: DateTimePickerProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mode === "time" ? value : displayDateTimeLocal(value));
  const [popover, setPopover] = useState({ top: 0, left: 0, width: 280, height: 260 });
  const parsed = splitDateTime(mode === "datetime" ? value : value ? `1970-01-01T${value}` : "");
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const [year, month] = parsed.date.split("-").map(Number);
    return { year, month };
  });

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDraft(mode === "time" ? value : displayDateTimeLocal(value));
    });
    return () => { cancelled = true; };
  }, [mode, value]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const [year, month] = parsed.date.split("-").map(Number);
    queueMicrotask(() => {
      if (!cancelled) setVisibleMonth({ year, month });
    });

    function place() {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = placePopover({
        field: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        popover: {
          width: Math.min(304, Math.max(260, rect.width)),
          height: mode === "time" ? 120 : 291,
        },
        inset: DATE_POPOVER_INSET,
      });
      setPopover(next);
    }

    place();
    const frame = window.requestAnimationFrame(() => {
      if (!cancelled) place();
    });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mode, open, parsed.date]);

  const cells = useMemo(
    () => calendarCells(visibleMonth.year, visibleMonth.month),
    [visibleMonth.month, visibleMonth.year],
  );

  const minuteOptions = minutes.includes(parsed.minutes) ? minutes : [...minutes, parsed.minutes].sort();

  function commitDateTime(date: string, hour: string, minute: string) {
    onChange(`${date}T${hour}:${minute}`);
    setDraft(`${date} ${hour}:${minute}`);
  }

  function commitTime(hour: string, minute: string) {
    onChange(`${hour}:${minute}`);
    setDraft(`${hour}:${minute}`);
  }

  function onFieldChange(next: string) {
    setDraft(next);
    if (!next.trim()) {
      onChange("");
      return;
    }
    try {
      if (mode === "time") onChange(parseTimeValue(next));
      else onChange(normalizeDateTimeLocal(next));
    } catch {
      // Keep the draft until blur/picker commit.
    }
  }

  function onFieldBlur() {
    if (!draft.trim()) {
      onChange("");
      setDraft("");
      return;
    }
    try {
      if (mode === "time") {
        const next = parseTimeValue(draft);
        onChange(next);
        setDraft(next);
      } else {
        const next = normalizeDateTimeLocal(draft);
        onChange(next);
        setDraft(displayDateTimeLocal(next));
      }
    } catch {
      setDraft(mode === "time" ? value : displayDateTimeLocal(value));
    }
  }

  function shiftMonth(delta: number) {
    const date = new Date(visibleMonth.year, visibleMonth.month - 1 + delta, 1);
    setVisibleMonth({ year: date.getFullYear(), month: date.getMonth() + 1 });
  }

  const popoverNode = open && !disabled ? createPortal(
    <div
      ref={popoverRef}
      className={`datetime-popover ${mode === "time" ? "is-time-only" : ""}`}
      style={{ top: popover.top, left: popover.left, width: popover.width, height: popover.height, maxHeight: popover.height }}
      role="dialog"
      aria-label={mode === "time" ? "选择时间" : "选择日期和时间"}
    >
      {mode === "datetime" && (
        <>
          <div className="datetime-popover-header">
            <button type="button" className="icon-button" aria-label="上个月" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={16} />
            </button>
            <strong>{visibleMonth.year}年{visibleMonth.month}月</strong>
            <button type="button" className="icon-button" aria-label="下个月" onClick={() => shiftMonth(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="datetime-weekdays">
            {weekdayLabels.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="datetime-grid">
            {cells.map((cell) => (
              <button
                key={cell.value + String(cell.inMonth)}
                type="button"
                className={`datetime-day ${cell.inMonth ? "" : "is-outside"} ${cell.value === parsed.date ? "is-selected" : ""}`}
                aria-label={cell.value}
                onClick={() => commitDateTime(cell.value, parsed.hours, parsed.minutes)}
              >
                {cell.day}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="datetime-time-row">
        <Clock size={15} />
        <select
          aria-label="小时"
          value={parsed.hours}
          onChange={(event) => {
            if (mode === "time") commitTime(event.target.value, parsed.minutes);
            else commitDateTime(parsed.date, event.target.value, parsed.minutes);
          }}
        >
          {hours.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
        </select>
        <span>:</span>
        <select
          aria-label="分钟"
          value={parsed.minutes}
          onChange={(event) => {
            if (mode === "time") commitTime(parsed.hours, event.target.value);
            else commitDateTime(parsed.date, parsed.hours, event.target.value);
          }}
        >
          {minuteOptions.map((minute) => <option key={minute} value={minute}>{minute}</option>)}
        </select>
        {value && (
          <button type="button" className="text-button" onClick={() => { onChange(""); setDraft(""); setOpen(false); }}>
            清除
          </button>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} className={`datetime-picker ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`}>
      <span className="datetime-picker-icon" aria-hidden="true">
        {mode === "time" ? <Clock size={15} /> : <CalendarDays size={15} />}
      </span>
      <input
        id={fieldId}
        value={draft}
        disabled={disabled}
        placeholder={mode === "time" ? "HH:MM" : "选择日期和时间"}
        aria-label={ariaLabel}
        aria-expanded={open}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onFieldChange(event.target.value)}
        onFocus={() => { if (!disabled) setOpen(true); }}
        onBlur={onFieldBlur}
        onClick={() => { if (!disabled) setOpen(true); }}
      />
      {value && (
        <button
          type="button"
          className="datetime-clear"
          aria-label="清除时间"
          disabled={disabled}
          onClick={() => { onChange(""); setDraft(""); setOpen(false); }}
        >
          <X size={14} />
        </button>
      )}
      {popoverNode}
    </div>
  );
}
