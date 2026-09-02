import { describe, expect, it } from "vitest";

import { describeDeadline, fromDateTimeLocal, localTimeZoneLabel, toDateTimeLocal } from "./date";

describe("deadline helpers", () => {
  it("round-trips a valid local date input", () => {
    const source = new Date(2026, 7, 31, 19, 30).getTime();
    expect(fromDateTimeLocal(toDateTimeLocal(source))).toBe(source);
  });

  it("returns null for an empty local date", () => {
    expect(fromDateTimeLocal("")).toBeNull();
  });

  it("rejects malformed or impossible local dates instead of silently clearing them", () => {
    expect(() => fromDateTimeLocal("not-a-date")).toThrow("截止时间格式无效");
    expect(() => fromDateTimeLocal("2026-02-30T12:00")).toThrow("当前时区不存在");
  });

  it("accepts a space-separated local date and still round-trips", () => {
    const source = new Date(2026, 7, 31, 19, 30).getTime();
    expect(fromDateTimeLocal("2026-08-31 19:30")).toBe(source);
  });

  it("describes the active local time zone and UTC offset", () => {
    expect(localTimeZoneLabel()).toMatch(/.+ · UTC[+-]\d{2}:\d{2}/);
  });

  it("describes overdue and upcoming deadlines", () => {
    const now = new Date(2026, 7, 31, 12, 0).getTime();
    expect(describeDeadline(now - 30 * 60_000, now)).toBe("已逾期 30 分钟");
    expect(describeDeadline(now + 2 * 60 * 60_000, now)).toBe("2 小时后");
  });
});
