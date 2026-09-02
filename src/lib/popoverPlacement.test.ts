import { describe, expect, it } from "vitest";

import { DATE_POPOVER_INSET, boxesOverlap, placePopover, type Box } from "./popoverPlacement";

const viewport = { width: 420, height: 640 };
const popover = { width: 280, height: 260 };
const inset = { top: 8, right: 8, bottom: 8, left: 8 };

function placedBox(field: Box) {
  const placed = placePopover({ field, viewport, popover, inset });
  return {
    placed,
    box: { top: placed.top, left: placed.left, width: placed.width, height: placed.height },
  };
}

function assertInsideViewport(box: Box) {
  expect(box.left).toBeGreaterThanOrEqual(inset.left);
  expect(box.top).toBeGreaterThanOrEqual(inset.top);
  expect(box.left + box.width).toBeLessThanOrEqual(viewport.width - inset.right + 0.01);
  expect(box.top + box.height).toBeLessThanOrEqual(viewport.height - inset.bottom + 0.01);
}

describe("placePopover", () => {
  it("places below a field near the top of a 420×640 window without covering it", () => {
    const field = { top: 56, left: 18, width: 240, height: 34 };
    const { placed, box } = placedBox(field);
    assertInsideViewport(box);
    expect(boxesOverlap(box, field)).toBe(false);
    expect(placed.top).toBeGreaterThanOrEqual(field.top + field.height);
  });

  it("places below a mid-window field when it still fits", () => {
    const field = { top: 280, left: 18, width: 240, height: 34 };
    const { box } = placedBox(field);
    assertInsideViewport(box);
    expect(boxesOverlap(box, field)).toBe(false);
  });

  it("places above a field near the bottom so it stays in the viewport", () => {
    const field = { top: 520, left: 18, width: 240, height: 34 };
    const { placed, box } = placedBox(field);
    assertInsideViewport(box);
    expect(boxesOverlap(box, field)).toBe(false);
    expect(placed.top + placed.height).toBeLessThanOrEqual(field.top);
  });

  it("shrinks to the remaining gap on a 340×420 window so a bottom capture field is not covered", () => {
    const minViewport = { width: 340, height: 420 };
    const calendar = { width: 280, height: 291 };
    for (const top of [280, 300, 330]) {
      const field = { top, left: 12, width: 220, height: 34 };
      const placed = placePopover({
        field,
        viewport: minViewport,
        popover: calendar,
        inset: DATE_POPOVER_INSET,
      });
      const box = { top: placed.top, left: placed.left, width: placed.width, height: placed.height };
      expect(placed.height).toBeGreaterThan(0);
      expect(placed.height).toBeLessThan(calendar.height);
      expect(placed.top).toBeGreaterThanOrEqual(DATE_POPOVER_INSET.top);
      expect(placed.top + placed.height).toBeLessThanOrEqual(
        minViewport.height - DATE_POPOVER_INSET.bottom + 0.01,
      );
      expect(boxesOverlap(box, field)).toBe(false);
    }
  });
});
