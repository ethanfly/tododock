import { describe, expect, it } from "vitest";

import { isRecordableShortcut, shortcutFromKeyboardEvent, shortcutLabel } from "./shortcut";

function keyEvent(partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key" | "code">): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("shortcut recording", () => {
  it("builds Alt+Space from a keyboard event", () => {
    expect(shortcutFromKeyboardEvent(keyEvent({ key: " ", code: "Space", altKey: true }))).toBe("Alt+Space");
  });

  it("builds Control+Alt+KeyQ from a keyboard event", () => {
    expect(shortcutFromKeyboardEvent(keyEvent({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true }))).toBe("Control+Alt+KeyQ");
  });

  it("ignores modifier-only presses and Escape", () => {
    expect(shortcutFromKeyboardEvent(keyEvent({ key: "Alt", code: "AltLeft", altKey: true }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyEvent({ key: "Escape", code: "Escape" }))).toBeNull();
  });

  it("labels shortcuts for Windows-style display", () => {
    expect(shortcutLabel("Alt+Space", false)).toBe("Alt + Space");
    expect(shortcutLabel("Control+Shift+KeyK", false)).toBe("Ctrl + Shift + K");
    expect(isRecordableShortcut("Alt+Space")).toBe(true);
    expect(isRecordableShortcut("Space")).toBe(false);
  });
});
