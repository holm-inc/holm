import type { Window } from "@holm/client";
import { useRef } from "react";

export interface HolmDockProps {
  windows: Window[];
  active: string | null;
  icons?: Record<string, string>;
  disabled?: boolean;
  disabledReason?: string;
  onFocus?: (id: string) => void;
  onClose?: (id: string) => void;
  className?: string;
}

export function HolmDock({ windows, active, icons, disabled, disabledReason, onFocus, onClose, className }: HolmDockProps) {
  const seen = useRef<string[]>([]);
  const present = new Set(windows.map((window) => window.id));
  seen.current = [
    ...seen.current.filter((id) => present.has(id)),
    ...windows.map((window) => window.id).filter((id) => !seen.current.includes(id)),
  ];
  const placed = [...windows].sort((a, b) => seen.current.indexOf(a.id) - seen.current.indexOf(b.id));

  return (
    <nav className={["holm-dock", className].filter(Boolean).join(" ")} aria-label="Windows">
      {windows.length === 0 ? (
        <span className="holm-dock__empty">No windows are open</span>
      ) : (
        <ul className="holm-dock__items">
          {placed.map((window) => {
            const name = window.title || window.class || window.id;
            const current = window.id === active;
            const icon = icons?.[window.id];
            return (
              <li key={window.id} className="holm-dock__item" data-active={current || undefined}>
                <button
                  type="button"
                  className="holm-dock__tile"
                  style={icon ? undefined : { background: tint(window.class || name) }}
                  data-icon={icon ? true : undefined}
                  disabled={disabled || !onFocus}
                  aria-current={current || undefined}
                  aria-label={`Focus ${name}`}
                  title={disabled && disabledReason ? `${name}: ${disabledReason}` : name}
                  onClick={() => onFocus?.(window.id)}
                >
                  {icon ? <img className="holm-dock__icon" src={icon} alt="" /> : initial(window.class || name)}
                </button>
                <span className="holm-dock__label">{name}</span>
                {onClose && !disabled && (
                  <button
                    type="button"
                    className="holm-dock__close"
                    aria-label={`Close ${name}`}
                    title={`Close ${name}`}
                    onClick={() => onClose(window.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function initial(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

function tint(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
}
