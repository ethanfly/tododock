// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { dirname, join } from "node:path";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { fileURLToPath } from "node:url";

import { CreateApp } from "./CreateApp";
import { SettingsApp } from "./SettingsApp";
import { TodoEditor } from "./components/TodoEditor";
import type { Todo } from "./types";

const cssText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

afterEach(cleanup);

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

function fieldChrome(el: Element) {
  const computed = getComputedStyle(el);
  const border = declared(el, "border");
  return {
    height: (computed.height && computed.height !== "auto" ? computed.height : "") || declared(el, "height") || declared(el, "min-height"),
    borderStyle: computed.borderStyle && computed.borderStyle !== "none"
      ? computed.borderStyle
      : declared(el, "border-style") || border.split(/\s+/)[1] || "",
    whiteSpace: computed.whiteSpace && computed.whiteSpace !== "normal"
      ? computed.whiteSpace
      : declared(el, "white-space"),
  };
}

beforeEach(() => {
  injectShippedCss();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">,
  });
});

const sampleTodo: Todo = {
  id: "01991a3b-e122-7fd0-a321-f4af72160cb8",
  title: "Reminder task",
  body: "",
  status: "open",
  priority: 0,
  deadlineAt: null,
  reminderMinutes: null,
  completedAt: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  sortOrder: 1024,
};

describe("form field chrome", () => {
  it("keeps settings, create, and editor controls on the shared field chrome", async () => {
    render(<SettingsApp />);
    await waitFor(() => expect(screen.getByLabelText("主题")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("静默时段"));

    expect(document.querySelector("input[type='datetime-local']")).toBeNull();
    expect(document.querySelector("input[type='time']")).toBeNull();
    expect(screen.queryByLabelText("禅道地址")).toBeNull();

    const theme = fieldChrome(screen.getByLabelText("主题"));
    const reminder = fieldChrome(screen.getByLabelText("默认提醒"));
    expect(theme.height).toBe("34px");
    expect(reminder.height).toBe(theme.height);
    expect(theme.borderStyle).toBe("solid");

    const directory = screen.getByText(/本地数据目录/);
    expect(declared(directory, "overflow-wrap")).toBe("anywhere");
    expect(declared(directory, "white-space")).not.toBe("nowrap");

    cleanup();
    render(<CreateApp />);
    await waitFor(() => expect(screen.getByLabelText("待办内容")).toBeInTheDocument());
    const add = fieldChrome(screen.getByRole("button", { name: "添加" }));
    expect(add.whiteSpace).toBe("nowrap");
    const createDeadline = screen.getByLabelText("截止时间").closest(".datetime-picker");
    expect(createDeadline).not.toBeNull();
    expect(fieldChrome(createDeadline!).height).toBe("36px");
    const deadlineInput = screen.getByLabelText("截止时间");
    expect(declared(deadlineInput, "border") === "0" || declared(deadlineInput, "border-width") === "0px" || declared(deadlineInput, "border-style") === "none").toBe(true);
    expect(document.querySelector(".markdown-editor")).toBeNull();

    cleanup();
    render(
      <TodoEditor todo={sampleTodo} defaultReminderMinutes={15} onClose={() => undefined} onSave={async () => undefined} />,
    );
    const deadline = screen.getByLabelText("截止时间").closest(".datetime-picker");
    const editorReminder = screen.getByLabelText("提醒");
    expect(deadline).not.toBeNull();
    expect(fieldChrome(deadline!).height).toBe(fieldChrome(editorReminder).height);
    expect(fieldChrome(deadline!).height).toBe("36px");
    expect(document.querySelector("input[type='datetime-local']")).toBeNull();

    const editorSurface = await waitFor(() => screen.getByRole("textbox", { name: "Markdown 备注，所见即所得" }));
    expect(declared(editorSurface, "min-height")).toBe("320px");
    expect(declared(editorSurface, "max-height")).toBe("480px");
  });

  it("gives the create Markdown editor a larger writing surface only after expand", async () => {
    render(<CreateApp />);
    await waitFor(() => expect(screen.getByLabelText("待办内容")).toBeInTheDocument());
    expect(document.querySelector(".markdown-editor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开 Markdown 备注" }));
    const surface = await waitFor(() => screen.getByRole("textbox", { name: "新建待办 Markdown 备注，所见即所得" }));
    expect(surface.closest(".markdown-editor")).not.toHaveClass("is-compact");
    expect(["0", "0px"]).toContain(declared(surface, "min-height"));
    expect(declared(surface, "max-height")).toBe("none");
    expect(document.querySelector(".app-shell")).toHaveClass("is-aux-window");
  });

  it("does not draw an extra ring around settings checkboxes", async () => {
    render(<SettingsApp />);
    await waitFor(() => expect(screen.getByLabelText("开机启动")).toBeInTheDocument());

    const checkbox = screen.getByLabelText("开机启动");
    checkbox.focus();
    expect(checkbox).toHaveFocus();
    expect(declared(checkbox, "appearance") || declared(checkbox, "-webkit-appearance")).toBe("none");
    expect(declared(checkbox, "box-shadow")).toBe("none");
    expect(declared(checkbox, "outline") === "none" || declared(checkbox, "outline-style") === "none").toBe(true);
    checkbox.click();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(declared(checkbox, "box-shadow")).toBe("none");
    expect(declared(checkbox, "outline") === "none" || declared(checkbox, "outline-style") === "none").toBe(true);
  });

  it("keeps a four-sided focus ring on the create title field", async () => {
    render(<CreateApp />);
    const input = await waitFor(() => screen.getByLabelText("待办内容"));
    input.focus();
    const fieldShadow = declared(input, "box-shadow");
    expect(fieldShadow).toMatch(/0\s+0\s+0\s+2px/);
    expect(fieldShadow.includes("inset")).toBe(false);

    cleanup();
    render(<SettingsApp />);
    const theme = await waitFor(() => screen.getByLabelText("主题"));
    theme.focus();
    const themeShadow = declared(theme, "box-shadow");
    expect(themeShadow).toMatch(/0\s+0\s+0\s+2px/);
    expect(themeShadow.includes("inset")).toBe(false);
  });
});
