import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";

import { isDesktopRuntime } from "../lib/api";
import { IconButton } from "./IconButton";

interface WindowChromeProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  bodyClassName?: string;
  children: ReactNode;
}

export function WindowChrome({ title, closeLabel, onClose, bodyClassName = "", children }: WindowChromeProps) {
  return (
    <main className="app-shell is-aux-window">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark"><Sparkles size={15} /></span>
          <span>{title}</span>
        </div>
        <div className="window-actions">
          <IconButton
            label="最小化"
            onClick={() => isDesktopRuntime() && void getCurrentWindow().minimize()}
          >
            <Minus size={16} />
          </IconButton>
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <section className={`workspace window-body ${bodyClassName}`.trim()}>{children}</section>
    </main>
  );
}
