// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { dirname, join } from "node:path";
// @ts-expect-error Vitest runs this file in Node and can read the shipped stylesheet.
import { fileURLToPath } from "node:url";

import { CreateApp } from "./CreateApp";
import { SettingsApp } from "./SettingsApp";
import { TodoEditor } from "./components/TodoEditor";
import * as api from "./lib/api";
import type { Todo } from "./types";

const cssText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    expect(fieldChrome(screen.getByLabelText("大模型端点")).height).toBe("34px");

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
    expect(["0", "0px"]).toContain(declared(editorSurface, "min-height"));
    expect(declared(editorSurface, "max-height")).toBe("none");
    expect(document.querySelector(".window-form")).toHaveClass("is-markdown-open");
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

  it("drops the light glass stroke on the window and empty orbit in dark theme", () => {
    const root = document.documentElement;
    const shell = document.createElement("main");
    shell.className = "app-shell";
    const orbit = document.createElement("span");
    orbit.className = "empty-orbit";
    document.body.append(shell, orbit);

    expect(declared(shell, "border")).toContain("var(--window-stroke)");
    expect(declared(orbit, "background")).toContain("var(--empty-orbit-fill)");
    expect(declared(root, "--window-stroke")).toMatch(/255,\s*255,\s*255,\s*0\.72/);

    root.dataset.theme = "dark";
    expect(declared(root, "--window-stroke")).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.07\)/);
    expect(declared(root, "--empty-orbit-fill")).not.toMatch(/236,\s*234,\s*255/);
    expect(declared(root, "--empty-orbit-fill")).not.toMatch(/255,\s*255,\s*255/);
    expect(declared(root, "--empty-orbit-ring")).toMatch(/149,\s*140,\s*255/);

    delete root.dataset.theme;
    shell.remove();
    orbit.remove();
  });
});

describe("form layout alignment", () => {
  it("keeps settings two-column, quiet-hours, and llm pairs shrinking instead of overflowing", async () => {
    render(<SettingsApp />);
    await waitFor(() => expect(screen.getByLabelText("主题")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("静默时段"));

    const grid = document.querySelector(".settings-grid");
    expect(grid).not.toBeNull();
    expect(declared(grid!, "grid-template-columns")).toBe("minmax(0, 1fr) minmax(0, 1fr)");
    expect(declared(grid!, "grid-template-columns")).toMatch(/minmax\(0,\s*1fr\)/);
    expect(cssText).toMatch(/@media \(max-width:\s*400px\)/);

    const themeLabel = screen.getByLabelText("主题").closest("label");
    expect(themeLabel).not.toBeNull();
    expect(declared(themeLabel!, "flex-direction")).toBe("column");
    expect(["0", "0px"]).toContain(declared(themeLabel!, "min-width"));

    const theme = fieldChrome(screen.getByLabelText("主题"));
    const reminder = fieldChrome(screen.getByLabelText("默认提醒"));
    const model = fieldChrome(screen.getByLabelText("大模型名称"));
    const apiKey = fieldChrome(screen.getByLabelText("大模型 API 密钥"));
    expect(theme.height).toBe("34px");
    expect(reminder.height).toBe(theme.height);
    expect(model.height).toBe(theme.height);
    expect(apiKey.height).toBe(theme.height);

    const quietRow = document.querySelector(".quiet-hours-field > span:last-child");
    expect(quietRow).not.toBeNull();
    expect(declared(quietRow!, "grid-template-columns")).toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
    expect(["0", "0px"]).toContain(declared(quietRow!, "min-width"));
    const quietStart = screen.getByLabelText("静默开始时间").closest(".datetime-picker");
    const quietEnd = screen.getByLabelText("静默结束时间").closest(".datetime-picker");
    expect(quietStart).not.toBeNull();
    expect(quietEnd).not.toBeNull();
    expect(fieldChrome(quietStart!).height).toBe("34px");
    expect(fieldChrome(quietEnd!).height).toBe(fieldChrome(quietStart!).height);
    expect(["0", "0px"]).toContain(declared(quietStart!, "min-width"));
    expect(["0", "0px"]).toContain(declared(quietEnd!, "min-width"));
  });

  it("keeps create footer, extra-draft row, and editor deadline/reminder aligned inside the form", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({
      ...api.defaultAppSettings,
      llmApiKey: "xai-key",
    });
    vi.spyOn(api, "generateTodosFromImages").mockResolvedValue([
      { title: "买牛奶", body: "", deadline: null },
      { title: "回邮件", body: "", deadline: null },
    ]);

    render(<CreateApp />);
    const title = await waitFor(() => screen.getByLabelText("待办内容"));
    await waitFor(() => expect(screen.getByRole("button", { name: "从剪贴板生成" })).toBeEnabled());

    const footer = document.querySelector(".editor-footer");
    const add = screen.getByRole("button", { name: "添加" });
    expect(footer).not.toBeNull();
    expect(declared(footer!, "display")).toBe("grid");
    expect(declared(footer!, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(["none", "0 0 auto"]).toContain(declared(footer!, "flex"));
    expect(declared(footer!, "position")).toBe("sticky");
    expect(fieldChrome(add).height).toBe("38px");
    expect(fieldChrome(add).whiteSpace).toBe("nowrap");

    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));
    const file = new File([bytes], "board.png", { type: "image/png" });
    fireEvent.paste(title, {
      clipboardData: {
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        files: [file],
      },
    });
    await waitFor(() => expect(screen.getByAltText("board.png")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "用已添加图片生成" }));
    const extraTitle = await waitFor(() => screen.getByLabelText("额外待办 1 标题"));
    const extraRow = extraTitle.closest("li");
    const extraRemove = screen.getByRole("button", { name: "移除额外待办 1" });
    expect(extraRow).not.toBeNull();
    expect(declared(extraRow!, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(["0", "0px"]).toContain(declared(extraRow!, "min-width"));
    expect(fieldChrome(extraTitle).height).toBe("36px");
    expect(fieldChrome(extraRemove).height).toBe(fieldChrome(extraTitle).height);

    fireEvent.click(screen.getByRole("button", { name: "展开 Markdown 备注" }));
    const form = document.querySelector(".window-form");
    const markdownField = document.querySelector(".create-markdown-field");
    const markdownEditor = document.querySelector(".markdown-editor");
    const surface = await waitFor(() => screen.getByRole("textbox", { name: "新建待办 Markdown 备注，所见即所得" }));
    expect(form).toHaveClass("is-markdown-open");
    expect(["none", "0 0 auto"]).toContain(declared(footer!, "flex"));
    expect(declared(markdownField!, "flex")).toMatch(/1/);
    expect(declared(markdownEditor!, "flex")).toMatch(/1/);
    expect(["0", "0px"]).toContain(declared(markdownEditor!, "min-height"));
    expect(["0", "0px"]).toContain(declared(surface, "min-height"));
    expect(declared(surface, "max-height")).toBe("none");
    expect(screen.getByRole("button", { name: "添加 2 项" })).toBeVisible();

    cleanup();
    render(
      <TodoEditor todo={sampleTodo} defaultReminderMinutes={15} onClose={() => undefined} onSave={async () => undefined} />,
    );
    const editorGrid = document.querySelector(".editor-grid");
    const deadline = screen.getByLabelText("截止时间").closest(".datetime-picker");
    const reminder = screen.getByLabelText("提醒");
    const editorFooter = document.querySelector(".editor-footer");
    const editorSurface = await waitFor(() => screen.getByRole("textbox", { name: "Markdown 备注，所见即所得" }));
    expect(editorGrid).not.toBeNull();
    expect(declared(editorGrid!, "grid-template-columns")).toBe("minmax(0, 1.2fr) minmax(0, 0.8fr)");
    expect(deadline).not.toBeNull();
    expect(fieldChrome(deadline!).height).toBe(fieldChrome(reminder).height);
    expect(fieldChrome(deadline!).height).toBe("36px");
    expect(["none", "0 0 auto"]).toContain(declared(editorFooter!, "flex"));
    expect(declared(editorFooter!, "position")).toBe("sticky");
    expect(["0", "0px"]).toContain(declared(editorSurface, "min-height"));
    expect(declared(editorSurface, "max-height")).toBe("none");
    expect(screen.getByRole("button", { name: "保存" })).toBeVisible();
  });
});
