// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShortcutRecorder } from "./ShortcutRecorder";

afterEach(cleanup);

describe("ShortcutRecorder", () => {
  it("captures Alt+Space after the field is armed", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value="Control+Shift+Space" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "全局快捷键" }));
    expect(screen.getByText("按下新的快捷键，Esc 取消")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: " ", code: "Space", altKey: true });
    expect(onChange).toHaveBeenCalledWith("Alt+Space");
  });

  it("cancels listening with Escape", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value="Alt+Space" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "全局快捷键" }));
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Alt + Space")).toBeInTheDocument();
  });
});
