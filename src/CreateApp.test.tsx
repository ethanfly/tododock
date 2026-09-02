// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateApp } from "./CreateApp";
import * as api from "./lib/api";

afterEach(cleanup);

beforeEach(() => {
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

describe("CreateApp window", () => {
  it("creates a todo from the independent window and does not mount Markdown until expanded", async () => {
    const createTodo = vi.spyOn(api, "createTodo");
    const closeWindow = vi.spyOn(api, "closeAuxiliaryWindow").mockResolvedValue(undefined);
    render(<CreateApp />);

    const title = await waitFor(() => screen.getByLabelText("待办内容"));
    expect(title).toHaveFocus();
    expect(screen.getByLabelText("截止时间")).toBeInTheDocument();
    expect(document.querySelector(".markdown-editor")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开 Markdown 备注" }));
    await waitFor(() => expect(document.querySelector(".markdown-editor")).not.toBeNull());
    expect(document.querySelector(".markdown-editor")).not.toHaveClass("is-compact");
    fireEvent.click(screen.getByRole("button", { name: "收起 Markdown 备注" }));
    expect(document.querySelector(".create-markdown-field")).toHaveClass("is-collapsed");
    expect(document.querySelector(".markdown-editor")).not.toBeNull();

    fireEvent.change(title, { target: { value: "买菜" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledWith(expect.objectContaining({ title: "买菜" })));
    await waitFor(() => expect(closeWindow).toHaveBeenCalled());
  });
});
