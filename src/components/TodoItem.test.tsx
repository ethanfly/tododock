// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { dirname, join } from "node:path";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { fileURLToPath } from "node:url";

import type { Todo } from "../types";
import { TodoItem } from "./TodoItem";

const cssText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

afterEach(() => {
  document.querySelector("style[data-tododock-styles]")?.remove();
});

function injectShippedCss() {
  document.querySelector("style[data-tododock-styles]")?.remove();
  const style = document.createElement("style");
  style.dataset.tododockStyles = "true";
  style.textContent = cssText;
  document.head.appendChild(style);
}

function declared(el: Element, property: string): string {
  let value = "";
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const matches = rule.selectorText.split(",").some((selector) => {
        try {
          return el.matches(selector.trim());
        } catch {
          return false;
        }
      });
      if (!matches) continue;
      const next = rule.style.getPropertyValue(property);
      if (next) value = next;
    }
  }
  return value.trim();
}

const todo: Todo = {
  id: "01991a3b-e122-7fd0-a321-f4af72160cb8",
  title: "Sortable task",
  body: "",
  status: "open",
  priority: 1,
  deadlineAt: null,
  reminderMinutes: null,
  completedAt: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  sortOrder: 1024,
};

describe("TodoItem", () => {
  it("supports keyboard sorting and archive actions", () => {
    const onMove = vi.fn();
    const onArchive = vi.fn();
    render(
      <TodoItem
        todo={todo}
        now={2}
        onToggle={() => undefined}
        onArchive={onArchive}
        onEdit={() => undefined}
        onDelete={() => undefined}
        reorderEnabled
        isFirst={false}
        isLast={false}
        onMove={onMove}
        onDrop={() => undefined}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 Sortable task" }), {
      key: "ArrowDown",
      altKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "归档 Sortable task" }));
    expect(onMove).toHaveBeenCalledWith(todo, 1);
    expect(onArchive).toHaveBeenCalledWith(todo, true);
  });

  it("restores an archived todo from the leading control", () => {
    const archived = { ...todo, status: "archived" as const, archivedAt: 3 };
    const onArchive = vi.fn();
    render(
      <TodoItem
        todo={archived}
        now={4}
        onToggle={() => undefined}
        onArchive={onArchive}
        onEdit={() => undefined}
        onDelete={() => undefined}
        reorderEnabled={false}
        isFirst
        isLast
        onMove={() => undefined}
        onDrop={() => undefined}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "恢复归档 Sortable task" })[0]);
    expect(onArchive).toHaveBeenCalledWith(archived, false);
  });

  it("vertically centers the drag handle with the checkbox", () => {
    injectShippedCss();
    render(
      <TodoItem
        todo={todo}
        now={2}
        onToggle={() => undefined}
        onArchive={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        reorderEnabled
        isFirst={false}
        isLast={false}
        onMove={() => undefined}
        onDrop={() => undefined}
      />,
    );
    const card = document.querySelector(".todo-card");
    const handle = document.querySelector(".drag-handle");
    const check = document.querySelector(".check-button");
    expect(card).not.toBeNull();
    expect(handle).not.toBeNull();
    expect(check).not.toBeNull();
    expect(declared(card!, "align-items")).toBe("center");
    expect(declared(handle!, "height")).toBe(declared(check!, "height"));
    expect(declared(handle!, "height")).toBe("22px");
    expect(declared(handle!, "place-items")).toBe("center");
  });
});
