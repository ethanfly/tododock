import { describe, expect, it } from "vitest";

import { isSafeLocalImageSrc } from "./safeImage";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("isSafeLocalImageSrc", () => {
  it("accepts compact raster data URLs and rejects remote or script sources", () => {
    expect(isSafeLocalImageSrc(png)).toBe(true);
    expect(isSafeLocalImageSrc("https://example.com/a.png")).toBe(false);
    expect(isSafeLocalImageSrc("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeLocalImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
  });
});
