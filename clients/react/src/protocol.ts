import type { ClipboardView, RecordingView, TakeoverView, ViewersView, Window } from "@holm/client";

export type ViewerMode = "view" | "control";

export interface Connection {
  url: string;
  expires_at_ms: number;
}

export interface WindowList {
  windows: Window[];
  active: string | null;
}

export interface ScreenStatus {
  viewers: ViewersView;
  recording: RecordingView;
}

export interface Ops {
  connect: { args: { mode: ViewerMode }; answer: Connection };
  status: { args: {}; answer: ScreenStatus };
  takeover: { args: {}; answer: TakeoverView };
  give_back: { args: {}; answer: {} };
  start_recording: { args: { fps?: number }; answer: RecordingView };
  stop_recording: { args: {}; answer: RecordingView };
  windows: { args: {}; answer: WindowList };
  focus_window: { args: { window: string }; answer: {} };
  close_window: { args: { window: string }; answer: {} };
  clipboard: { args: {}; answer: ClipboardView };
  set_clipboard: { args: { text: string }; answer: {} };
}

export type Op = keyof Ops;

export const OPS: readonly Op[] = [
  "connect",
  "status",
  "takeover",
  "give_back",
  "start_recording",
  "stop_recording",
  "windows",
  "focus_window",
  "close_window",
  "clipboard",
  "set_clipboard",
];

export type Call<O extends Op = Op> = { op: O; box_id: string; screen: number } & Ops[O]["args"];
