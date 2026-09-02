// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { editableElementToMarkdown, isLikelyMarkdownSource, plainTextEditorToMarkdown } from "./markdownEditor";

describe("editableElementToMarkdown", () => {
  it("preserves rich blocks as portable Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<h2>Roadmap</h2>",
      "<p><strong>Fast</strong> and <em>local</em></p>",
      "<ul><li><input type='checkbox' checked>ship it</li></ul>",
      "<pre><code>npm test\n</code></pre>",
    ].join("");

    expect(editableElementToMarkdown(root)).toBe([
      "## Roadmap",
      "",
      "**Fast** and _local_",
      "",
      "- [x] ship it",
      "",
      "```",
      "npm test",
      "```",
    ].join("\n"));
  });

  it("serializes nested lists, safe links, and tables", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<ol><li>first<ul><li>nested</li></ul></li></ol>",
      "<p><a href='https://example.com/a'>docs</a></p>",
      "<table><thead><tr><th>Name</th><th>State</th></tr></thead><tbody><tr><td>Todo</td><td>Ready</td></tr></tbody></table>",
    ].join("");

    expect(editableElementToMarkdown(root)).toContain("1. first\n  - nested");
    expect(editableElementToMarkdown(root)).toContain("[docs](https://example.com/a)");
    expect(editableElementToMarkdown(root)).toContain("| Name | State |\n| --- | --- |\n| Todo | Ready |");
  });

  it("preserves a non-loading image placeholder as Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p><span data-markdown-image-source='https://example.com/a.png' data-markdown-image-alt='diagram'>图片 · diagram</span></p>";

    expect(editableElementToMarkdown(root)).toBe("![diagram](https://example.com/a.png)");
  });

  it("serializes an inline local image as Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p><img src='data:image/png;base64,AAA' alt='shot'></p>";

    expect(editableElementToMarkdown(root)).toBe("![shot](data:image/png;base64,AAA)");
  });

  it("keeps raw Markdown typed into a plain visual surface", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div>**important**</div><div>- [ ] review</div><div>`code`</div>";

    const value = plainTextEditorToMarkdown(root);
    expect(value).toBe("**important**\n- [ ] review\n`code`");
    expect(isLikelyMarkdownSource(value ?? "")).toBe(true);
  });

  it("keeps Markdown typed through IME wrapper spans", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div>### <span>你好</span></div>";

    const value = plainTextEditorToMarkdown(root);
    expect(value).toBe("### 你好");
    expect(isLikelyMarkdownSource(value ?? "")).toBe(true);
  });

  it("does not mistake literal HTML for Markdown syntax", () => {
    const root = document.createElement("div");
    root.textContent = "literal <script> text";

    const value = plainTextEditorToMarkdown(root);
    expect(value).toBe("literal <script> text");
    expect(isLikelyMarkdownSource(value ?? "")).toBe(false);
  });

  it("escapes angle brackets so literal HTML-looking text survives rendering", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>literal &lt;script&gt; text</p>";

    expect(editableElementToMarkdown(root)).toBe("literal \\<script\\> text");
  });
});
