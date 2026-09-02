// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateApp } from "./CreateApp";
import * as api from "./lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("creates multiple todos generated from images", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({
      ...api.defaultAppSettings,
      llmApiKey: "xai-key",
    });
    const generate = vi.spyOn(api, "generateTodosFromImages").mockResolvedValue([
      { title: "买牛奶", body: "", deadline: null },
      { title: "回邮件", body: "明天", deadline: "2026-09-03T18:00" },
    ]);
    const createTodo = vi.spyOn(api, "createTodo");
    render(<CreateApp />);

    const title = await waitFor(() => screen.getByLabelText("待办内容"));
    await waitFor(() => expect(screen.getByRole("button", { name: "从剪贴板生成" })).toBeEnabled());
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
    await waitFor(() => expect(generate).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("待办内容")).toHaveValue("买牛奶"));
    expect(screen.getByLabelText("额外待办 1 标题")).toHaveValue("回邮件");

    fireEvent.click(screen.getByRole("button", { name: "添加 2 项" }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledTimes(2));
    expect(createTodo).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "买牛奶" }));
    expect(createTodo).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "回邮件", body: "明天" }));
  });
});
