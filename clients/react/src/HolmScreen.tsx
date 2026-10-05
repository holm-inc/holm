import { HolmError } from "@holm/client";
import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import type { ScreenController } from "./controller.js";
import type { ViewerMode } from "./protocol.js";

export type LinkState = "connecting" | "connected" | "disconnected" | "failed";

export interface ScreenLink {
  paste(text: string): void;
  focus(): void;
}

export interface HolmScreenProps {
  controller: ScreenController;
  mode?: ViewerMode;
  onLinkChange?: (state: LinkState, reason?: string) => void;
  onClipboard?: (text: string) => void;
  linkRef?: RefObject<ScreenLink | null>;
  retries?: number;
  background?: string;
  className?: string;
  style?: CSSProperties;
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export function HolmScreen({
  controller,
  mode = "view",
  onLinkChange,
  onClipboard,
  linkRef,
  retries = RETRY_MS.length,
  background = "#0e0e10",
  className,
  style,
}: HolmScreenProps) {
  const target = useRef<HTMLDivElement>(null);
  const latest = useRef({ controller, onLinkChange, onClipboard, linkRef });
  latest.current = { controller, onLinkChange, onClipboard, linkRef };

  useEffect(() => {
    const element = target.current;
    if (!element) return;

    const abort = new AbortController();
    let rfb: import("@novnc/novnc").default | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let refused = false;
    const tell = (state: LinkState, reason?: string) => {
      if (!abort.signal.aborted) latest.current.onLinkChange?.(state, reason);
    };

    const open = async () => {
      tell("connecting");
      try {
        const [{ default: RFB }, connection] = await Promise.all([
          import("@novnc/novnc"),
          latest.current.controller.call("connect", { mode }, abort.signal),
        ]);
        if (abort.signal.aborted) return;

        rfb = new RFB(element, connection.url, { wsProtocols: ["binary"] });
        rfb.viewOnly = mode !== "control";
        rfb.scaleViewport = true;
        rfb.clipViewport = false;
        rfb.background = background;
        const live = rfb;
        rfb.addEventListener("connect", () => {
          failures = 0;
          const ref = latest.current.linkRef;
          if (ref) ref.current = { paste: (text) => live.clipboardPasteFrom(text), focus: () => live.focus() };
          tell("connected");
        });
        rfb.addEventListener("clipboard", (event) => {
          latest.current.onClipboard?.((event as CustomEvent<{ text: string }>).detail.text);
        });
        rfb.addEventListener("disconnect", (event) => {
          rfb = null;
          const ref = latest.current.linkRef;
          if (ref) ref.current = null;
          if (refused) return;
          if ((event as CustomEvent<{ clean: boolean }>).detail.clean) tell("disconnected");
          else retry("lost the screen");
        });
        rfb.addEventListener("securityfailure", (event) => {
          refused = true;
          tell("failed", (event as CustomEvent<{ reason?: string }>).detail.reason ?? "the screen refused the connection");
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof HolmError && !error.retryable) tell("failed", reason);
        else retry(reason);
      }
    };

    const retry = (reason: string) => {
      if (abort.signal.aborted) return;
      if (failures >= retries) return tell("failed", reason);
      const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] ?? 8000;
      failures += 1;
      tell("connecting", reason);
      timer = setTimeout(open, wait);
    };

    void open();

    return () => {
      abort.abort();
      clearTimeout(timer);
      rfb?.disconnect();
      if (latest.current.linkRef) latest.current.linkRef.current = null;
      element.replaceChildren();
    };
  }, [controller.key, mode, retries, background]);

  return <div ref={target} className={className} style={{ width: "100%", height: "100%", ...style }} />;
}
