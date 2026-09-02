import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
}

export function IconButton({ label, children, active = false, className = "", ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      {...props}
    >
      {children}
    </button>
  );
}

