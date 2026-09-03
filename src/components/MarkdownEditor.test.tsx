// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATE_POPOVER_INSET, boxesOverlap } from "../lib/popoverPlacement";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ControlledEditor({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  return <MarkdownEditor value={value} onChange={setValue} ariaLabel="测试备注" />;
}

describe("MarkdownEditor", () => {
  it("renders Markdown in the visual editing surface", async () => {
    render(<ControlledEditor initialValue={"## Today\n\n**important**\n\n- [x] shipped"} />);

    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    await waitFor(() => expect(editor.querySelector("h2")).toHaveTextContent("Today"));
    expect(editor.querySelector("strong")).toHaveTextContent("important");
    expect(editor.querySelector<HTMLInputElement>("input[type='checkbox']")).toBeChecked();
  });

  it("emits Markdown after editing the visual DOM", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} ariaLabel="测试备注" />);

    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    editor.innerHTML = "<p><strong>Bold</strong> text</p>";
    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith("**Bold** text");
  });

  it("keeps Markdown typed into a plain visual surface unescaped", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} ariaLabel="测试备注" />);

    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    editor.innerHTML = "<div>**Bold**</div><div>- [ ] follow up</div>";
    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith("**Bold**\n- [ ] follow up");
  });

  it("switches to an editable Markdown source without losing content", async () => {
    render(<ControlledEditor initialValue={"## Source\n\n- one"} />);

    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    const source = screen.getByRole("textbox", { name: "测试备注，Markdown 源码" });
    expect(source).toHaveValue("## Source\n\n- one");

    fireEvent.change(source, { target: { value: "**changed**" } });
    fireEvent.click(screen.getByRole("button", { name: "所见即所得" }));
    const visual = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    await waitFor(() => expect(visual.querySelector("strong")).toHaveTextContent("changed"));
  });

  it("renders a heading typed as Markdown in the visual surface", async () => {
    render(<ControlledEditor initialValue="" />);
    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    editor.focus();
    editor.innerHTML = "<div>### 你好</div>";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(editor.querySelector("h3")).toHaveTextContent("你好"));
  });

  it("renders Markdown after IME composition ends", async () => {
    render(<ControlledEditor initialValue="" />);
    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    editor.focus();
    fireEvent.compositionStart(editor);
    editor.innerHTML = "<div>### <span>你好</span></div>";
    fireEvent.input(editor);
    expect(editor.querySelector("h3")).toBeNull();
    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(editor.querySelector("h3")).toHaveTextContent("你好"));
  });

  it("renders typed Markdown after an idle pause", async () => {
    render(<ControlledEditor initialValue="" />);
    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    editor.focus();
    editor.innerHTML = "<div>**重要**</div>";
    fireEvent.input(editor);
    await waitFor(() => expect(editor.querySelector("strong")).toHaveTextContent("重要"), { timeout: 1000 });
  });

  it("does not reparse already rendered Markdown while typing", async () => {
    render(<ControlledEditor initialValue={"## Long note\n\ntext"} />);
    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    await waitFor(() => expect(editor.querySelector("h2")).toHaveTextContent("Long note"));
    fireEvent.focus(editor);
    const template = document.querySelector<HTMLElement>(".markdown-editor-template");
    await waitFor(() => expect(template).toBeEmptyDOMElement());
    editor.querySelector("h2")?.append("!");
    fireEvent.input(editor);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(template).toBeEmptyDOMElement();
    expect(editor.querySelector("h2")).toHaveTextContent("Long note!");
  });

  it("rebuilds the visual surface when source mode is unchanged", async () => {
    render(<ControlledEditor initialValue={"## Source\n\n- one"} />);

    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "所见即所得" }));
    const visual = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    await waitFor(() => expect(visual.querySelector("h2")).toHaveTextContent("Source"));
  });

  it("opens an in-app link dialog instead of window.prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    render(<ControlledEditor initialValue="" />);

    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    expect(prompt).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "插入链接" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("链接地址")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "https://example.com" } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(exec).toHaveBeenCalledWith("insertHTML", false, expect.stringContaining("https://example.com"));
    expect(screen.queryByRole("dialog", { name: "插入链接" })).toBeNull();
  });

  it("inserts a pasted image into the visual editor", async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    render(<ControlledEditor initialValue="" />);
    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const clipboardData = {
      getData: () => "",
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      files: [file],
    };
    fireEvent.paste(editor, { clipboardData });
    await waitFor(() => expect(exec).toHaveBeenCalledWith("insertHTML", false, expect.stringContaining("data:image/")));
  });

  it("keeps links editable without navigating the desktop webview", async () => {
    render(<ControlledEditor initialValue="[docs](https://example.com)" />);

    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    const link = await waitFor(() => {
      const value = editor.querySelector("a");
      expect(value).not.toBeNull();
      return value!;
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("does not keep a hidden Markdown parser mounted while editing", async () => {
    render(<ControlledEditor initialValue={"## Long note\n\ntext"} />);

    const editor = screen.getByRole("textbox", { name: "测试备注，所见即所得" });
    await waitFor(() => expect(editor.querySelector("h2")).toHaveTextContent("Long note"));
    const template = document.querySelector<HTMLElement>(".markdown-editor-template");
    expect(template).not.toBeNull();
    expect(template).not.toBeEmptyDOMElement();

    fireEvent.focus(editor);
    await waitFor(() => expect(template).toBeEmptyDOMElement());
    editor.textContent = "edited";
    fireEvent.input(editor);
    expect(template).toBeEmptyDOMElement();

    fireEvent.blur(editor);
    await waitFor(() => expect(template).not.toBeEmptyDOMElement());
  });

  it("does not parse a hidden template while editing Markdown source", async () => {
    render(<ControlledEditor initialValue={"## Source"} />);

    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    const source = screen.getByRole("textbox", { name: "测试备注，Markdown 源码" });
    const template = document.querySelector<HTMLElement>(".markdown-editor-template");
    expect(template).toBeEmptyDOMElement();

    fireEvent.change(source, { target: { value: "# changed" } });
    expect(template).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "所见即所得" }));
    await waitFor(() => expect(template).not.toBeEmptyDOMElement());
  });

  it.each([
    { name: "420×640", width: 420, height: 640, tops: [56, 280, 540] },
    { name: "340×420", width: 340, height: 420, tops: [56, 180, 330] },
  ])("places the link dialog inside a $name window without covering the trigger", ({ width, height, tops }) => {
    const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });

    try {
      for (const top of tops) {
        const fieldBox = { top, left: 18, width: 28, height: 28 };
        const { unmount } = render(<ControlledEditor initialValue="" />);
        const trigger = screen.getByRole("button", { name: "链接" });
        trigger.getBoundingClientRect = () => ({
          ...fieldBox,
          right: fieldBox.left + fieldBox.width,
          bottom: fieldBox.top + fieldBox.height,
          x: fieldBox.left,
          y: fieldBox.top,
          toJSON() { return {}; },
        });
        fireEvent.click(trigger);
        const dialog = screen.getByRole("dialog", { name: "插入链接" });
        const placed = {
          top: Number.parseFloat(dialog.style.top),
          left: Number.parseFloat(dialog.style.left),
          width: Number.parseFloat(dialog.style.width),
          height: Number.parseFloat(dialog.style.height || dialog.style.maxHeight),
        };
        expect(placed.height).toBeGreaterThan(0);
        expect(placed.top).toBeGreaterThanOrEqual(DATE_POPOVER_INSET.top);
        expect(placed.left).toBeGreaterThanOrEqual(DATE_POPOVER_INSET.left);
        expect(placed.left + placed.width).toBeLessThanOrEqual(width - DATE_POPOVER_INSET.right + 0.01);
        expect(placed.top + placed.height).toBeLessThanOrEqual(height - DATE_POPOVER_INSET.bottom + 0.01);
        expect(boxesOverlap(placed, fieldBox)).toBe(false);
        unmount();
      }
    } finally {
      if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
      if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
    }
  });
});
