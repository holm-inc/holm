import { useCallback, useEffect, useRef, useState } from "react";
import type { Window } from "@holm/client";
import type { ScreenController } from "./controller.js";
import type { Op, Ops, ScreenStatus, ViewerMode } from "./protocol.js";

export interface UseScreenOptions {
  pollMs?: number;
  readOnly?: boolean;
}

export interface ScreenHandle {
  status: ScreenStatus | null;
  mode: ViewerMode;
  driving: boolean;
  busy: boolean;
  error: string | null;
  windows: Window[];
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
  const current = useRef(controller);
  current.current = controller;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await current.current.call("status", {}, signal);
      setStatus(next);
      if (!next.viewers.taken_over) setDriving(false);
    } catch (failure) {
      if (!signal?.aborted) setError(message(failure));
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setStatus(null);
    setDriving(false);
    setWindows([]);
    void refresh(abort.signal);
    const timer = setInterval(() => void refresh(abort.signal), pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [controller.key, pollMs, refresh]);

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
    if (listed) setWindows(listed);
  }, [run]);

  const focusWindow = useCallback(
    async (id: string) => {
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
