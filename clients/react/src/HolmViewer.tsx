import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ScreenController } from "./controller.js";
import { HolmScreen, type LinkState, type ScreenLink } from "./HolmScreen.js";
import { useScreen } from "./useScreen.js";

export interface HolmViewerProps {
  controller: ScreenController;
  readOnly?: boolean;
  pollMs?: number;
  aspectRatio?: string;
  className?: string;
  style?: CSSProperties;
}

type Drawer = "windows" | "clipboard" | null;

export function HolmViewer({
  controller,
  readOnly = false,
  pollMs,
  aspectRatio = "16 / 10",
  className,
  style,
}: HolmViewerProps) {
  const screen = useScreen(controller, { pollMs, readOnly });
  const root = useRef<HTMLDivElement>(null);
  const linkRef = useRef<ScreenLink | null>(null);
  const [link, setLink] = useState<{ state: LinkState; reason?: string | undefined }>({ state: "connecting" });
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [clip, setClip] = useState("");
  const [full, setFull] = useState(false);

  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const recording = screen.status?.recording.recording ?? false;
  const toggle = (next: Drawer) => {
    setDrawer(drawer === next ? null : next);
    if (next === "windows" && drawer !== "windows") void screen.refreshWindows();
  };
  const sendClipboard = () => {
    if (screen.driving && linkRef.current) linkRef.current.paste(clip);
    else void screen.writeClipboard(clip);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen();
  };

  return (
    <div
      ref={root}
      className={["holm-viewer", className].filter(Boolean).join(" ")}
      data-link={link.state}
      data-driving={screen.driving || undefined}
      data-recording={recording || undefined}
      style={style}
    >
      <div className="holm-viewer__bar" role="toolbar" aria-label="Screen controls">
        <span className="holm-viewer__status" aria-live="polite">
          {describe(
            link.state,
            screen.driving,
            !screen.driving && (screen.status?.viewers.taken_over ?? false),
            recording,
            others(screen.status, link.state),
          )}
        </span>
        <span className="holm-viewer__spacer" />
        {!readOnly &&
          (screen.driving ? (
            <button type="button" disabled={screen.busy} onClick={() => void screen.giveBack()}>
              Give back
            </button>
          ) : (
            <button type="button" disabled={screen.busy} onClick={() => void screen.takeover()}>
              Take over
            </button>
          ))}
        {!readOnly &&
          (recording ? (
            <button type="button" disabled={screen.busy} onClick={() => void screen.stopRecording()}>
              Stop recording
            </button>
          ) : (
            <button type="button" disabled={screen.busy} onClick={() => void screen.startRecording()}>
              Record
            </button>
          ))}
        {!readOnly && (
          <button type="button" aria-pressed={drawer === "windows"} onClick={() => toggle("windows")}>
            Windows
          </button>
        )}
        {!readOnly && (
          <button type="button" aria-pressed={drawer === "clipboard"} onClick={() => toggle("clipboard")}>
            Clipboard
          </button>
        )}
        <button type="button" aria-pressed={full} onClick={fullscreen}>
          {full ? "Exit full screen" : "Full screen"}
        </button>
      </div>

      {drawer === "windows" && (
        <div className="holm-viewer__drawer">
          {screen.windows.length === 0 ? (
            <p className="holm-viewer__empty">No windows are open.</p>
          ) : (
            <ul className="holm-viewer__windows">
              {screen.windows.map((window) => (
                <li key={window.id}>
                  <span title={window.class}>{window.title || window.class || window.id}</span>
                  <button
                    type="button"
                    disabled={screen.busy || screen.driving}
                    title={screen.driving ? "You are driving: use the screen" : undefined}
                    onClick={() => void screen.focusWindow(window.id)}
                  >
                    Focus
                  </button>
                  <button
                    type="button"
                    disabled={screen.busy || screen.driving}
                    title={screen.driving ? "You are driving: use the screen" : undefined}
                    onClick={() => void screen.closeWindow(window.id)}
                  >
                    Close
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={screen.busy} onClick={() => void screen.refreshWindows()}>
            Refresh
          </button>
        </div>
      )}

      {drawer === "clipboard" && (
        <div className="holm-viewer__drawer">
          <textarea
            aria-label="Clipboard text"
            value={clip}
            onChange={(event) => setClip(event.target.value)}
            rows={3}
          />
          <div className="holm-viewer__row">
            <button
              type="button"
              disabled={screen.busy}
              onClick={async () => {
                const text = await screen.readClipboard();
                if (text !== null) setClip(text);
              }}
            >
              Read from box
            </button>
            <button type="button" disabled={screen.busy} onClick={sendClipboard}>
              Send to box
            </button>
          </div>
        </div>
      )}

      {(screen.error || link.state === "failed") && (
        <div className="holm-viewer__error" role="alert">
          {screen.error ?? link.reason ?? "the screen is not available"}
          {screen.error && (
            <button type="button" aria-label="Dismiss" onClick={screen.clearError}>
              ×
            </button>
          )}
        </div>
      )}

      <div className="holm-viewer__screen" style={full ? undefined : { aspectRatio }}>
        <HolmScreen
          controller={controller}
          mode={screen.mode}
          onLinkChange={(state, reason) => setLink({ state, reason })}
          onClipboard={setClip}
          linkRef={linkRef}
        />
      </div>
    </div>
  );
}

function others(status: ReturnType<typeof useScreen>["status"], link: LinkState): number {
  if (!status) return 0;
  return Math.max(0, status.viewers.watching + status.viewers.driving - (link === "connected" ? 1 : 0));
}

function describe(link: LinkState, driving: boolean, held: boolean, recording: boolean, more: number): string {
  const parts = [
    link === "connected"
      ? driving
        ? "You are driving"
        : held
          ? "Watching · a person has the screen"
          : "Watching"
      : link === "connecting"
        ? "Connecting"
        : link === "failed"
          ? "Not connected"
          : "Disconnected",
  ];
  if (recording) parts.push("recording");
  if (more > 0) parts.push(`${more} more watching`);
  return parts.join(" · ");
}
