import { describe, expect, it } from "vitest";

import { preloadMarkdownEditor } from "./preloadMarkdownEditor";

describe("preloadMarkdownEditor", () => {
  it("loads the shipped Markdown editor module once", async () => {
    const first = await preloadMarkdownEditor();
    expect(first.MarkdownEditor).toEqual(expect.any(Function));
    await expect(preloadMarkdownEditor()).resolves.toBe(first);
  });
});
