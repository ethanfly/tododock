import { PanelTopClose, Settings2 } from "lucide-react";
import { useEffect, useRef } from "react";

interface CloseToTrayDialogProps {
  onHide: () => void;
  onOpenSettings: () => void;
  onCancel: () => void;
}

const focusableSelector = "button:not([disabled])";

export function CloseToTrayDialog({ onHide, onOpenSettings, onCancel }: CloseToTrayDialogProps) {
  const hideButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    hideButtonRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <section
        className="close-explainer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-explainer-title"
        aria-describedby="close-explainer-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(focusableSelector)];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first && last && event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (first && last && !event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <span className="close-explainer-icon"><PanelTopClose size={22} /></span>
        <div>
          <span className="eyebrow">后台常驻</span>
          <h2 id="close-explainer-title">TodoDock 会收进系统托盘</h2>
          <p id="close-explainer-description">
            这样全局快捷键和 deadline 提醒仍能工作。可从托盘再次打开，也可在设置中改为关闭时直接退出。
          </p>
        </div>
        <div className="close-explainer-actions">
          <button type="button" className="text-button" onClick={onOpenSettings}>
            <Settings2 size={14} />打开设置
          </button>
          <button ref={hideButtonRef} type="button" className="primary-button compact" onClick={onHide}>知道了，隐藏</button>
        </div>
      </section>
    </div>
  );
}
