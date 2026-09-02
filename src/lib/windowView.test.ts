import { describe, expect, it } from "vitest";

import { getWindowView } from "./windowView";

describe("getWindowView", () => {
  it("routes hash and query to independent window views", () => {
    expect(getWindowView({ hash: "", search: "" })).toBe("main");
    expect(getWindowView({ hash: "#/create", search: "" })).toBe("create");
    expect(getWindowView({ hash: "#/settings", search: "" })).toBe("settings");
    expect(getWindowView({ hash: "", search: "?window=create" })).toBe("create");
    expect(getWindowView({ hash: "", search: "?window=settings" })).toBe("settings");
    expect(getWindowView({ hash: "#/other", search: "" })).toBe("main");
  });
});
