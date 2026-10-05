import { useCallback, useEffect, useRef, useState } from "react";
import type { Window } from "@holm/client";
import type { ScreenController } from "./controller.js";
import type { Op, Ops, ScreenStatus, ViewerMode } from "./protocol.js";

export interface UseScreenOptions {
  pollMs?: number;
  readOnly?: boolean;
  watchWindows?: boolean;
}

export interface ScreenHandle {
  status: ScreenStatus | null;
  mode: ViewerMode;
  driving: boolean;
  busy: boolean;
  error: string | null;
  windows: Window[];
  activeWindow: string | null;
  icons: Record<string, string>;
  takeover(): Promise<void>;
  giveBack(): Promise<void>;
  startRecording(fps?: number): Promise<void>;
  stopRecording(): Promise<void>;
  refreshWindows(): Promise<void>;
  focusWindow(id: string): Promise<void>;
  closeWindow(id: string): Promise<void>;
  readClipboard(): Promise<string | null>;
  writeClipboard(text: string): Promise<void>;
  clearError(): void;
}

export function useScreen(controller: ScreenController, options: UseScreenOptions = {}): ScreenHandle {
  const pollMs = options.pollMs ?? 3000;
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [driving, setDriving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windows, setWindows] = useState<Window[]>([]);
  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const asked = useRef(new Map<string, Promise<string | null>>());
  const watchWindows = options.watchWindows ?? false;
  const current = useRef(controller);
  current.current = controller;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [next, listed] = await Promise.all([
          current.current.call("status", {}, signal),
          watchWindows ? current.current.call("windows", {}, signal) : null,
        ]);
        setStatus(next);
        if (!next.viewers.taken_over) setDriving(false);
        if (listed) {
          setWindows(listed.windows);
          setActiveWindow(listed.active);
        }
      } catch (failure) {
        if (!signal?.aborted) setError(message(failure));
      }
    },
    [watchWindows],
  );

  useEffect(() => {
    const abort = new AbortController();
    setStatus(null);
    setDriving(false);
    setWindows([]);
    setActiveWindow(null);
    setIcons({});
    asked.current = new Map();
    void refresh(abort.signal);
    const timer = setInterval(() => void refresh(abort.signal), pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [controller.key, pollMs, refresh]);

  useEffect(() => {
    let live = true;
    for (const window of windows) {
      const app = window.class || window.id;
      let icon = asked.current.get(app);
      if (!icon) {
        icon = current.current.call("window_icon", { window: window.id }).then(
          (answer) => answer.icon,
          () => null,
        );
        asked.current.set(app, icon);
      }
      void icon.then((found) => {
        if (live && found) setIcons((held) => (held[window.id] === found ? held : { ...held, [window.id]: found }));
      });
    }
    return () => {
      live = false;
    };
  }, [windows]);

  const run = useCallback(
    async <O extends Op>(op: O, args: Ops[O]["args"]): Promise<Ops[O]["answer"] | null> => {
      setBusy(true);
      setError(null);
      try {
        return await current.current.call(op, args);
      } catch (failure) {
        setError(message(failure));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const takeover = useCallback(async () => {
    if (options.readOnly) return;
    if (await run("takeover", {})) setDriving(true);
    await refresh();
  }, [run, refresh, options.readOnly]);

  const giveBack = useCallback(async () => {
    if (await run("give_back", {})) setDriving(false);
    await refresh();
  }, [run, refresh]);

  const startRecording = useCallback(
    async (fps?: number) => {
      await run("start_recording", fps === undefined ? {} : { fps });
      await refresh();
    },
    [run, refresh],
  );

  const stopRecording = useCallback(async () => {
    await run("stop_recording", {});
    await refresh();
  }, [run, refresh]);

  const refreshWindows = useCallback(async () => {
    const listed = await run("windows", {});
    if (listed) {
      setWindows(listed.windows);
      setActiveWindow(listed.active);
    }
  }, [run]);

  const focusWindow = useCallback(
    async (id: string) => {
      setActiveWindow(id);
      await run("focus_window", { window: id });
      await refreshWindows();
    },
    [run, refreshWindows],
  );

  const closeWindow = useCallback(
    async (id: string) => {
      await run("close_window", { window: id });
      await refreshWindows();
    },
    [run, refreshWindows],
  );

  const readClipboard = useCallback(async () => (await run("clipboard", {}))?.text ?? null, [run]);

  const writeClipboard = useCallback(
    async (text: string) => {
      await run("set_clipboard", { text });
    },
    [run],
  );

  return {
    status,
    mode: driving && !options.readOnly ? "control" : "view",
    driving,
    busy,
    error,
    windows,
    activeWindow,
    icons,
    takeover,
    giveBack,
    startRecording,
    stopRecording,
    refreshWindows,
    focusWindow,
    closeWindow,
    readClipboard,
    writeClipboard,
    clearError: () => setError(null),
  };
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
