export function toDateTimeLocal(timestamp: number | null): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

export function normalizeDateTimeLocal(value: string): string {
  const trimmed = value.trim().replace(" ", "T");
  if (!trimmed) return "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    throw new Error("截止时间格式无效");
  }
  return trimmed;
}

export function fromDateTimeLocal(value: string): number | null {
  if (!value.trim()) return null;
  const normalized = normalizeDateTimeLocal(value);
  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hours, minutes);
  const offsets = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
    offsets.add(new Date(localAsUtc + deltaHours * 3_600_000).getTimezoneOffset());
  }
  const matches = [...offsets]
    .map((offset) => localAsUtc + offset * 60_000)
    .filter((timestamp, index, values) => (
      Number.isFinite(timestamp) &&
      values.indexOf(timestamp) === index &&
      toDateTimeLocal(timestamp) === normalized
    ));

  if (matches.length === 0) {
    throw new Error("该本地时间在当前时区不存在，请选择其他时间（可能处于夏令时跳变区间）");
  }
  if (matches.length > 1) {
    throw new Error("该本地时间在当前时区对应两个时刻，请避开夏令时回拨的歧义区间");
  }
  return matches[0];
}

export function localTimeZoneLabel(now = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60).toString().padStart(2, "0");
  const minutes = (Math.abs(offset) % 60).toString().padStart(2, "0");
  return `${zone} · UTC${sign}${hours}:${minutes}`;
}

export function describeDeadline(timestamp: number | null, now = Date.now()): string | null {
  if (timestamp === null) return null;
  const difference = timestamp - now;
  const absoluteMinutes = Math.round(Math.abs(difference) / 60_000);

  if (difference < 0) {
    if (absoluteMinutes < 60) return `已逾期 ${absoluteMinutes || 1} 分钟`;
    const hours = Math.round(absoluteMinutes / 60);
    if (hours < 24) return `已逾期 ${hours} 小时`;
    return `已逾期 ${Math.round(hours / 24)} 天`;
  }

  if (absoluteMinutes < 60) return `${absoluteMinutes || 1} 分钟后`;
  const hours = Math.round(absoluteMinutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  if (hours < 48) return "明天";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function displayDateTimeLocal(value: string): string {
  if (!value) return "";
  try {
    return normalizeDateTimeLocal(value).replace("T", " ");
  } catch {
    return value;
  }
}

export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function buildDateTimeLocal(year: number, month: number, day: number, hours: number, minutes: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hours)}:${pad2(minutes)}`;
}

export function parseTimeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^\d{2}:\d{2}$/.test(trimmed)) {
    throw new Error("时间格式必须为 HH:MM");
  }
  const [hours, minutes] = trimmed.split(":").map(Number);
  if (hours > 23 || minutes > 59) {
    throw new Error("时间超出有效范围");
  }
  return trimmed;
}

export interface CalendarCell {
  day: number;
  inMonth: boolean;
  value: string;
}

export function calendarCells(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month - 1, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  const cells: CalendarCell[] = [];

  for (let index = 0; index < 42; index += 1) {
    const dayNumber = index - startOffset + 1;
    if (dayNumber < 1) {
      const day = prevMonthDays + dayNumber;
      const date = new Date(year, month - 2, day);
      cells.push({
        day,
        inMonth: false,
        value: buildDateTimeLocal(date.getFullYear(), date.getMonth() + 1, day, 0, 0).slice(0, 10),
      });
    } else if (dayNumber > daysInMonth) {
      const day = dayNumber - daysInMonth;
      const date = new Date(year, month, day);
      cells.push({
        day,
        inMonth: false,
        value: buildDateTimeLocal(date.getFullYear(), date.getMonth() + 1, day, 0, 0).slice(0, 10),
      });
    } else {
      cells.push({
        day: dayNumber,
        inMonth: true,
        value: buildDateTimeLocal(year, month, dayNumber, 0, 0).slice(0, 10),
      });
    }
  }

  while (cells.length > 35 && cells.slice(-7).every((cell) => !cell.inMonth)) {
    cells.splice(-7);
  }
  return cells;
}
