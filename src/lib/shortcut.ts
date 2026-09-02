const modifierOrder = ["CommandOrControl", "Command", "Super", "Control", "Alt", "Shift"] as const;

const codeAliases: Record<string, string> = {
  " ": "Space",
  Spacebar: "Space",
  Esc: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push(navigator.platform.toLowerCase().includes("mac") ? "Command" : "Super");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  const key = shortcutKeyFromEvent(event);
  if (!key) return null;
  if (modifiers.length === 0) return null;
  return [...sortModifiers(modifiers), key].join("+");
}

export function shortcutKeyFromEvent(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(event.key)) return null;
  if (event.code.startsWith("Key") || event.code.startsWith("Digit") || event.code.startsWith("F")) {
    return event.code;
  }
  if (event.code === "Space" || event.key === " ") return "Space";
  if (codeAliases[event.key]) return codeAliases[event.key];
  if (event.code && /^[A-Z][A-Za-z]+$/.test(event.code)) return event.code;
  return null;
}

export function sortModifiers(modifiers: string[]): string[] {
  return [...modifiers].sort(
    (left, right) => modifierOrder.indexOf(left as typeof modifierOrder[number]) - modifierOrder.indexOf(right as typeof modifierOrder[number]),
  );
}

export function shortcutLabel(value: string, isMac = navigator.userAgent.includes("Mac")): string {
  return value
    .replaceAll("CommandOrControl", isMac ? "⌘" : "Ctrl")
    .replaceAll("Command", "⌘")
    .replaceAll("Control", "Ctrl")
    .replaceAll("Super", "Win")
    .replaceAll("Meta", isMac ? "⌘" : "Win")
    .replaceAll("Digit", "")
    .replaceAll("Key", "")
    .replaceAll("+", " + ");
}

export function isRecordableShortcut(value: string): boolean {
  const parts = value.split("+").filter(Boolean);
  return parts.length >= 2 && parts.slice(0, -1).every((part) => (
    ["Control", "Alt", "Shift", "Super", "Command", "CommandOrControl", "Meta"].includes(part)
  ));
}
