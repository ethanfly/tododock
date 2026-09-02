// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { boxesOverlap } from "../lib/popoverPlacement";
import { DateTimePicker } from "./DateTimePicker";

afterEach(cleanup);

describe("DateTimePicker", () => {
  it("commits a typed datetime without using a native picker", () => {
    const onChange = vi.fn();
    render(<DateTimePicker aria-label="截止时间" value="" onChange={onChange} />);
    expect(document.querySelector("input[type='datetime-local']")).toBeNull();
    fireEvent.change(screen.getByLabelText("截止时间"), { target: { value: "2030-01-02T10:30" } });
    expect(onChange).toHaveBeenCalledWith("2030-01-02T10:30");
  });

  it("picks a calendar day and keeps the current time", () => {
    const onChange = vi.fn();
    render(<DateTimePicker aria-label="截止时间" value="2026-09-01T18:00" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("截止时间"));
    fireEvent.click(screen.getByRole("button", { name: "2026-09-15" }));
    expect(onChange).toHaveBeenCalledWith("2026-09-15T18:00");
  });

  it("records a time-only value", () => {
    const onChange = vi.fn();
    render(<DateTimePicker mode="time" aria-label="开始时间" value="22:00" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "08:30" } });
    expect(onChange).toHaveBeenCalledWith("08:30");
  });

  it("applies a fitted popover height that does not cover the field in a 340×420 window", () => {
    const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 340 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });

    try {
      for (const top of [280, 300, 330]) {
        const fieldBox = { top, left: 12, width: 220, height: 34 };
        const onChange = vi.fn();
        const { unmount } = render(
          <DateTimePicker aria-label="截止时间" value="2026-09-01T18:00" onChange={onChange} />,
        );
        const field = screen.getByLabelText("截止时间").closest(".datetime-picker");
        expect(field).not.toBeNull();
        field!.getBoundingClientRect = () => ({
          ...fieldBox,
          right: fieldBox.left + fieldBox.width,
          bottom: fieldBox.top + fieldBox.height,
          x: fieldBox.left,
          y: fieldBox.top,
          toJSON() { return {}; },
        });
        fireEvent.click(screen.getByLabelText("截止时间"));
        const dialog = screen.getByRole("dialog", { name: "选择日期和时间" });
        const placed = {
          top: Number.parseFloat(dialog.style.top),
          left: Number.parseFloat(dialog.style.left),
          width: Number.parseFloat(dialog.style.width),
          height: Number.parseFloat(dialog.style.height || dialog.style.maxHeight),
        };
        expect(placed.height).toBeGreaterThan(0);
        expect(placed.height).toBeLessThan(291);
        expect(dialog.style.height).toBe(`${placed.height}px`);
        expect(dialog.style.maxHeight).toBe(`${placed.height}px`);
        expect(boxesOverlap(placed, fieldBox)).toBe(false);
        unmount();
      }
    } finally {
      if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
      if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
    }
  });
});
