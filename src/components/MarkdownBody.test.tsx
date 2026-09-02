// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/" }

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownBody } from "./MarkdownBody";

afterEach(cleanup);

describe("MarkdownBody", () => {
  it("renders GFM while dropping raw HTML", () => {
    const { container } = render(
      <MarkdownBody markdown={"**安全预览**\n\n<img src=x onerror=alert(1)>\n\n- [x] done"} />,
    );

    expect(screen.getByText("安全预览").tagName).toBe("STRONG");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not expose unsafe link protocols", () => {
    render(<MarkdownBody markdown={"[unsafe](javascript:alert(1))\n\n[relative](/internal)"} />);
    expect(screen.getByText("unsafe").closest("a")).not.toHaveAttribute("href");
    expect(screen.getByText("relative").closest("a")).not.toHaveAttribute("href");
  });

  it("does not automatically load remote Markdown images", () => {
    render(<MarkdownBody markdown="![tracking pixel](https://example.com/pixel.png)" />);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "图片：tracking pixel" })).toHaveTextContent("图片 · tracking pixel");
  });

  it("renders local data-URL images", () => {
    const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    render(<MarkdownBody markdown={`![diagram](${source})`} />);
    const image = document.querySelector("img");
    expect(image).toHaveAttribute("src", source);
    expect(image).toHaveAttribute("alt", "diagram");
  });
});
