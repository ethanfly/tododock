import { describe, expect, it } from "vitest";

import { getEditTodoId, getWindowView } from "./windowView";

describe("getWindowView", () => {
  it("routes hash and query to independent window views", () => {
    expect(getWindowView({ hash: "", search: "" })).toBe("main");
    expect(getWindowView({ hash: "#/create", search: "" })).toBe("create");
    expect(getWindowView({ hash: "#/settings", search: "" })).toBe("settings");
    expect(getWindowView({ hash: "#/edit/01991a3b-e122-7fd0-a321-f4af72160cb8", search: "" })).toBe("edit");
    expect(getWindowView({ hash: "", search: "?window=create" })).toBe("create");
    expect(getWindowView({ hash: "", search: "?window=settings" })).toBe("settings");
    expect(getWindowView({ hash: "", search: "?window=edit&id=01991a3b-e122-7fd0-a321-f4af72160cb8" })).toBe("edit");
    expect(getWindowView({ hash: "#/other", search: "" })).toBe("main");
  });
});

describe("getEditTodoId", () => {
  it("reads a UUID from the edit hash or query", () => {
    const id = "01991a3b-e122-7fd0-a321-f4af72160cb8";
    expect(getEditTodoId({ hash: `#/edit/${id}`, search: "" })).toBe(id);
    expect(getEditTodoId({ hash: "", search: `?window=edit&id=${id}` })).toBe(id);
    expect(getEditTodoId({ hash: "#/edit/not-a-uuid", search: "" })).toBeNull();
    expect(getEditTodoId({ hash: "#/create", search: "" })).toBeNull();
  });
});
