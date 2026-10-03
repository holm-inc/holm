// @vitest-environment jsdom
import { HolmError } from "@holm/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenController } from "../src/controller.js";
import { HolmViewer } from "../src/HolmViewer.js";
import type { Op } from "../src/protocol.js";

const sockets: { url: string; viewOnly: boolean; rfb: EventTarget }[] = [];
const pasted: string[] = [];

vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    background = "";
    constructor(_target: HTMLElement, url: string) {
      super();
      const entry = { url, viewOnly: false, rfb: this as EventTarget };
      sockets.push(entry);
      queueMicrotask(() => {
        entry.viewOnly = this.viewOnly;
        this.dispatchEvent(new Event("connect"));
      });
    }
    disconnect() {}
    focus() {}
    clipboardPasteFrom(text: string) {
      pasted.push(text);
    }
  },
}));

function fake(overrides: Partial<Record<Op, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: [Op, Record<string, unknown>][] = [];
  let takenOver = false;
  let recording = false;
  let active = "w2";
  const answers: Record<Op, (args: Record<string, unknown>) => unknown> = {
    connect: (args) => ({ url: `wss://box/socket?mode=${String(args.mode)}`, expires_at_ms: 0 }),
    status: () => ({
      viewers: { watching: 2, driving: 0, person_driving: false, taken_over: takenOver },
      recording: { recording },
    }),
    takeover: () => ((takenOver = true), { exclusive: true, screen: 0 }),
    give_back: () => ((takenOver = false), {}),
    start_recording: () => ((recording = true), { recording }),
    stop_recording: () => ((recording = false), { recording }),
    windows: () => ({
      windows: [
        { id: "w1", title: "Chrome", class: "Chromium" },
        { id: "w2", title: "Terminal", class: "XTerm" },
      ],
      active,
    }),
    focus_window: (args) => ((active = String(args.window)), {}),
    close_window: () => ({}),
    clipboard: () => ({ text: "from the box" }),
    set_clipboard: () => ({}),
    ...overrides,
  };
  const controller: ScreenController = {
    key: "test",
    async call(op, args) {
      calls.push([op, args as Record<string, unknown>]);
      return answers[op](args as Record<string, unknown>) as never;
    },
  };
  return { controller, calls };
}

afterEach(() => {
  cleanup();
  sockets.length = 0;
  pasted.length = 0;
});

describe("HolmViewer", () => {
  it("watches, then drives after a takeover, then watches again", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);

    await screen.findByText(/Watching · 1 more watching/);
    expect(sockets.at(-1)).toMatchObject({ url: "wss://box/socket?mode=view", viewOnly: true });

    fireEvent.click(screen.getByText("Take over"));
    await screen.findByText(/You are driving/);
    expect(sockets.at(-1)).toMatchObject({ url: "wss://box/socket?mode=control", viewOnly: false });

    fireEvent.click(screen.getByText("Give back"));
    await screen.findByText("Take over");
    await waitFor(() => expect(sockets.at(-1)?.url).toBe("wss://box/socket?mode=view"));
    expect(calls.map(([op]) => op)).toContain("give_back");
  });

  it("starts and stops a recording", async () => {
    const { controller } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Record"));
    await screen.findByText(/Watching · recording/);
    fireEvent.click(screen.getByText("Stop recording"));
    await screen.findByText("Record");
  });

  it("docks the windows, marks the active one, and focuses on a click", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    const chrome = await screen.findByLabelText("Focus Chrome");
    expect(screen.getByLabelText("Focus Terminal").getAttribute("aria-current")).toBe("true");
    expect(chrome.textContent).toBe("C");
    fireEvent.click(chrome);
    await waitFor(() => expect(calls).toContainEqual(["focus_window", { window: "w1" }]));
    expect(chrome.getAttribute("aria-current")).toBe("true");
  });

  it("keeps the dock's order when the stacking order changes", async () => {
    let order = ["w1", "w2"];
    const all = { w1: { id: "w1", title: "Chrome" }, w2: { id: "w2", title: "Terminal" } } as const;
    const { controller } = fake({
      windows: () => ({ windows: order.map((id) => all[id as "w1" | "w2"]), active: order.at(-1) }),
      focus_window: (args) => ((order = [...order.filter((id) => id !== args.window), String(args.window)]), {}),
    });
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(await screen.findByLabelText("Focus Chrome"));
    await waitFor(() => expect(screen.getByLabelText("Focus Chrome").getAttribute("aria-current")).toBe("true"));
    const labels = screen.getAllByRole("button", { name: /^Focus / }).map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Focus Chrome", "Focus Terminal"]);
  });

  it("closes a window from the dock", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(await screen.findByLabelText("Close Terminal"));
    await waitFor(() => expect(calls).toContainEqual(["close_window", { window: "w2" }]));
  });

  it("leaves the dock out when asked", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} dock={false} pollMs={60_000} />);
    await screen.findByText(/Watching/);
    expect(screen.queryByRole("navigation", { name: "Windows" })).toBeNull();
    expect(calls.map(([op]) => op)).not.toContain("windows");
  });

  it("reads and sends the clipboard", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(screen.getByText("Clipboard"));
    fireEvent.click(screen.getByText("Read from box"));
    const box = await screen.findByDisplayValue("from the box");
    fireEvent.change(box, { target: { value: "to the box" } });
    fireEvent.click(screen.getByText("Send to box"));
    await waitFor(() => expect(calls).toContainEqual(["set_clipboard", { text: "to the box" }]));
  });

  it("pastes over the screen while driving, since the server refuses API input then", async () => {
    const { controller, calls } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Take over"));
    await screen.findByText(/You are driving/);
    fireEvent.click(screen.getByText("Clipboard"));
    fireEvent.change(screen.getByLabelText("Clipboard text"), { target: { value: "typed by a person" } });
    fireEvent.click(screen.getByText("Send to box"));
    expect(pasted).toEqual(["typed by a person"]);
    expect(calls.map(([op]) => op)).not.toContain("set_clipboard");
  });

  it("shows the box's clipboard when it changes", async () => {
    const { controller } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    await screen.findByText(/Watching/);
    fireEvent.click(screen.getByText("Clipboard"));
    act(() => {
      sockets.at(-1)!.rfb.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "copied in the box" } }));
    });
    await screen.findByDisplayValue("copied in the box");
  });

  it("only shows the dock while driving", async () => {
    const { controller } = fake();
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    fireEvent.click(await screen.findByText("Take over"));
    await screen.findByText(/You are driving/);
    expect((screen.getByLabelText("Focus Chrome") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Close Chrome")).toBeNull();
  });

  it("hides the controls when read only", async () => {
    const { controller } = fake();
    render(<HolmViewer controller={controller} readOnly pollMs={60_000} />);
    await screen.findByText(/Watching/);
    expect(screen.queryByText("Take over")).toBeNull();
    expect(screen.queryByText("Record")).toBeNull();
    expect((await screen.findByLabelText("Focus Chrome") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Close Chrome")).toBeNull();
  });

  it("stops at a refusal it cannot retry", async () => {
    const { controller, calls } = fake({
      connect: () => {
        throw new HolmError({ code: "denied", message: "not yours", retryable: false }, 403);
      },
    });
    render(<HolmViewer controller={controller} pollMs={60_000} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("not yours");
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(calls.filter(([op]) => op === "connect")).toHaveLength(1);
  });
});
