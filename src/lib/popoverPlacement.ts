export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function boxesOverlap(a: Box, b: Box, epsilon = 0.5): boolean {
  return (
    a.left + epsilon < b.left + b.width
    && a.left + a.width - epsilon > b.left
    && a.top + epsilon < b.top + b.height
    && a.top + a.height - epsilon > b.top
  );
}

export const DATE_POPOVER_INSET: Inset = { top: 48, right: 8, bottom: 36, left: 8 };

export function placePopover({
  field,
  viewport,
  popover,
  gap = 6,
  inset = { top: 8, right: 8, bottom: 8, left: 8 },
}: {
  field: Box;
  viewport: { width: number; height: number };
  popover: { width: number; height: number };
  gap?: number;
  inset?: Inset;
}): { top: number; left: number; width: number; height: number } {
  const maxWidth = Math.max(0, viewport.width - inset.left - inset.right);
  const width = Math.min(popover.width, maxWidth);
  const maxHeight = Math.max(0, viewport.height - inset.top - inset.bottom);
  let height = Math.min(popover.height, maxHeight);

  const minLeft = inset.left;
  const maxLeft = viewport.width - inset.right - width;
  let left = Math.min(Math.max(minLeft, field.left), Math.max(minLeft, maxLeft));

  const spaceBelow = viewport.height - inset.bottom - (field.top + field.height) - gap;
  const spaceAbove = field.top - inset.top - gap;
  const fitsBelow = spaceBelow >= height - 0.01;
  const fitsAbove = spaceAbove >= height - 0.01;

  let top: number;
  if (fitsBelow) {
    top = field.top + field.height + gap;
  } else if (fitsAbove) {
    top = field.top - gap - height;
  } else {
    const rightLeft = field.left + field.width + gap;
    const leftLeft = field.left - gap - width;
    const fitsRight = rightLeft + width <= viewport.width - inset.right + 0.01;
    const fitsLeft = leftLeft >= inset.left - 0.01;
    if (fitsRight || fitsLeft) {
      left = fitsRight ? rightLeft : leftLeft;
      top = Math.min(
        Math.max(inset.top, field.top),
        Math.max(inset.top, viewport.height - inset.bottom - height),
      );
    } else if (spaceAbove >= spaceBelow) {
      height = Math.max(0, Math.min(height, spaceAbove));
      top = field.top - gap - height;
    } else {
      height = Math.max(0, Math.min(height, spaceBelow));
      top = field.top + field.height + gap;
    }
  }

  return { top, left, width, height };
}
