// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CloseToTrayDialog } from "./CloseToTrayDialog";

afterEach(cleanup);

describe("CloseToTrayDialog", () => {
  it("explains background behavior and exposes both choices", () => {
    const onHide = vi.fn();
    const onOpenSettings = vi.fn();
    render(<CloseToTrayDialog onHide={onHide} onOpenSettings={onOpenSettings} onCancel={() => undefined} />);

    expect(screen.getByRole("dialog", { name: "TodoDock 会收进系统托盘" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("button", { name: "知道了，隐藏" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("keeps focus inside and lets Escape cancel without hiding", () => {
    const onCancel = vi.fn();
    render(
      <CloseToTrayDialog
        onHide={() => undefined}
        onOpenSettings={() => undefined}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const settings = screen.getByRole("button", { name: "打开设置" });
    const hide = screen.getByRole("button", { name: "知道了，隐藏" });
    expect(document.activeElement).toBe(hide);

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(hide);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
