import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";

import { shortcutFromKeyboardEvent, shortcutLabel } from "../lib/shortcut";

interface ShortcutRecorderProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function ShortcutRecorder({ value, onChange, disabled = false, ariaLabel = "全局快捷键" }: ShortcutRecorderProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        setListening(false);
        return;
      }
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      onChange(shortcut);
      setListening(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listening, onChange]);

  useEffect(() => {
    if (!disabled) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setListening(false);
    });
    return () => { cancelled = true; };
  }, [disabled]);

  return (
    <button
      type="button"
      className={`shortcut-recorder ${listening ? "is-listening" : ""}`}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={listening}
      onClick={() => { if (!disabled) setListening(true); }}
    >
      <Keyboard size={15} />
      <span>{listening ? "按下新的快捷键，Esc 取消" : shortcutLabel(value)}</span>
    </button>
  );
}
