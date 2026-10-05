import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Holm, HolmError, UnreadableError, viewerSocketUrl, type BoxView } from "../src/index.js";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fake(answer: (seen: Seen) => Response = () => json({})) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Seen = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(call);
    return answer(call);
  };
  return { seen, holm: new Holm({ baseUrl: "https://api.example.com/", apiKey: "smk_test", fetch }) };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function view(state: BoxView["state"], extra: Partial<BoxView> = {}): BoxView {
  return {
    id: "box_1",
    spec_digest: "d",
    state,
    screens: 1,
    width: 1280,
    height: 800,
    created_at_ms: 0,
    ...extra,
  } as BoxView;
}

describe("transport", () => {
  it("sends the key as a bearer and trims the base", async () => {
    const { seen, holm } = fake(() => json({ boxes: [] }));
    await holm.boxes.list();
    expect(seen[0]!.url.toString()).toBe("https://api.example.com/v1/boxes");
    expect(seen[0]!.headers.authorization).toBe("Bearer smk_test");
  });

  it("turns an error body into a HolmError", async () => {
    const { holm } = fake(() => json({ code: "not_found", message: "no box box_9", retryable: false }, 404));
    const error = await holm.boxes.get("box_9").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HolmError);
    expect(error).toMatchObject({ code: "not_found", status: 404, retryable: false });
  });

  it("keeps an answer it cannot read", async () => {
    const { holm } = fake(() => new Response("bad gateway", { status: 502 }));
    await expect(holm.boxes.list()).rejects.toBeInstanceOf(UnreadableError);
  });

  it("leaves unset query values out", async () => {
    const { seen, holm } = fake(() => json([]));
    await holm.box("box_1").cookies.list();
    expect(seen[0]!.url.search).toBe("");
  });
});

describe("boxes", () => {
  it("waits while a created box is starting", async () => {
    let polls = 0;
    const { seen, holm } = fake((call) =>
      call.method === "POST" ? json(view("starting"), 202) : json(view(++polls < 2 ? "starting" : "ready")),
    );
    const box = await holm.boxes.create({ spec: {} as never }, { pollMs: 1, idempotencyKey: "k1" });
    expect(box.view?.state).toBe("ready");
    expect(seen[0]!.headers["idempotency-key"]).toBe("k1");
    expect(seen.length).toBe(3);
  });

  it("fails when the box fails to start", async () => {
    const { holm } = fake((call) =>
      call.method === "POST" ? json(view("starting"), 202) : json(view("failed", { reason: "no image" })),
    );
    await expect(holm.boxes.create({ spec: {} as never }, { pollMs: 1 })).rejects.toMatchObject({
      code: "failed",
      message: "failed: no image",
    });
  });

  it("confirms a delete", async () => {
    const { seen, holm } = fake(() => new Response(null, { status: 204 }));
    await holm.box("box_1").delete();
    expect(seen[0]!.headers["x-holm-confirm-delete"]).toBe("yes");
  });
});

describe("files", () => {
  it("round-trips bytes through base64", async () => {
    let stored = "";
    const { holm } = fake((call) => {
      if (call.method === "PUT") {
        stored = (call.body as { contents_base64: string }).contents_base64;
        return new Response(null, { status: 204 });
      }
      return json({ path: "/a", contents_base64: stored });
    });
    const files = holm.box("box_1").files;
    await files.write("/a", "héllo");
    expect(await files.readText("/a")).toBe("héllo");
  });
});

describe("viewer", () => {
  it("builds the socket from the token", () => {
    const url = viewerSocketUrl("https://api.example.com", "box_1", 0, { ticket: "t1", expires_at_ms: 0 }, "control");
    expect(url).toBe("wss://api.example.com/v1/boxes/box_1/screens/0/viewer/socket?ticket=t1&mode=control");
  });

  it("prefers a signed socket", () => {
    const token = { ticket: "t1", expires_at_ms: 0, view_socket: "wss://direct/view" };
    expect(viewerSocketUrl("https://api.example.com", "box_1", 0, token, "view")).toBe("wss://direct/view");
  });
});

describe("coverage", () => {
  const spec = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };

  const calls: Record<string, (holm: Holm) => Promise<unknown>> = {
    health: (h) => h.health(),
    catalog: (h) => h.catalog(),
    list_boxes: (h) => h.boxes.list(),
    create_box: (h) => h.boxes.create({ spec: {} as never }, { wait: false }),
    get_box: (h) => h.box("b").refresh(),
    delete_box: (h) => h.box("b").delete(),
    fork: (h) => h.box("b").fork({}, { wait: false }),
    pause_box: (h) => h.box("b").pause(),
    resume_box: (h) => h.box("b").resume(),
    stop_box: (h) => h.box("b").stop(),
    exec: (h) => h.box("b").exec({ argv: ["true"] }),
    install_apps: (h) => h.box("b").installApps({} as never),
    read_trace: (h) => h.box("b").trace(),
    trace_frame: (h) => h.box("b").traceFrame("x"),
    save_state: (h) => h.box("b").saveState({} as never),
    load_state: (h) => h.box("b").loadState({} as never),
    read_file: (h) => h.box("b").files.read("/x"),
    write_file: (h) => h.box("b").files.write("/x", ""),
    list_dir: (h) => h.box("b").files.list("/"),
    grep: (h) => h.box("b").files.grep({} as never),
    glob: (h) => h.box("b").files.glob({ pattern: "*" }),
    list_tabs: (h) => h.box("b").page.tabs(),
    focus_tab: (h) => h.box("b").page.focusTab("t"),
    close_tab: (h) => h.box("b").page.closeTab("t"),
    read_page: (h) => h.box("b").page.read(),
    find_elements: (h) => h.box("b").page.find(),
    snapshot_page: (h) => h.box("b").page.snapshot(),
    on_element: (h) => h.box("b").page.element({} as never),
    evaluate: (h) => h.box("b").page.evaluate({} as never),
    page_screenshot: (h) => h.box("b").page.screenshot(),
    page_pdf: (h) => h.box("b").page.pdf(),
    page_console: (h) => h.box("b").page.console(),
    token: (h) => h.box("b").page.cdp(),
    list_cookies: (h) => h.box("b").cookies.list(),
    set_cookies: (h) => h.box("b").cookies.set({} as never),
    clear_cookies: (h) => h.box("b").cookies.clear(),
    actions: (h) => h.box("b").screen(0).act({} as never),
    frame: (h) => h.box("b").screen(0).frame(),
    cursor: (h) => h.box("b").screen(0).cursor(),
    on_node: (h) => h.box("b").screen(0).node({} as never),
    get_clipboard: (h) => h.box("b").screen(0).clipboard(),
    set_clipboard: (h) => h.box("b").screen(0).setClipboard({} as never),
    start_takeover: (h) => h.box("b").screen(0).takeover(),
    end_takeover: (h) => h.box("b").screen(0).endTakeover(),
    viewers: (h) => h.box("b").screen(0).viewers(),
    ticket: (h) => h.box("b").screen(0).viewerToken(),
    recording: (h) => h.box("b").screen(0).recording(),
    start_recording: (h) => h.box("b").screen(0).startRecording(),
    stop_recording: (h) => h.box("b").screen(0).stopRecording(),
    list_windows: (h) => h.box("b").screen(0).windows.list(),
    active_window: (h) => h.box("b").screen(0).windows.active(),
    await_window: (h) => h.box("b").screen(0).windows.waitFor({} as never),
    focus_window: (h) => h.box("b").screen(0).windows.focus("w"),
    window_icon: (h) => h.box("b").screen(0).windows.icon("w"),
    arrange_window: (h) => h.box("b").screen(0).windows.arrange("w", {} as never),
    close_window: (h) => h.box("b").screen(0).windows.close("w"),
    list_runtimes: (h) => h.runtimes.list(),
    get_runtime: (h) => h.runtimes.get("r"),
    add_runtime: (h) => h.runtimes.add({} as never),
    change_runtime: (h) => h.runtimes.change("r", {} as never),
    forget_runtime: (h) => h.runtimes.remove("r"),
    list_images: (h) => h.images.list(),
    list_runtime_images: (h) => h.images.list("r"),
    image_status: (h) => h.images.status("r", "d"),
    prepare_image: (h) => h.images.prepare("r", {} as never, { wait: false }),
    forget_image: (h) => h.images.forget("r", "d"),
    list_states: (h) => h.states.list(),
    forget_state: (h) => h.states.forget("s"),
  };

  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ id: op.operationId, method: method.toUpperCase(), path })),
  );

  it("has a call for every operation", () => {
    expect(operations.map((op) => op.id).filter((id) => !(id in calls))).toEqual([]);
  });

  it.each(operations)("$id reaches $method $path", async ({ id, method, path }) => {
    const call = calls[id];
    if (!call) return;
    const answer = { ok: true, service: "holm-server", boxes: [], runtimes: [], images: [], box: view("ready"), replay: {} };
    const { seen, holm } = fake(() => json({ ...view("ready"), ...answer, contents_base64: "", image_base64: "" }));
    await call(holm);
    const pattern = new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    expect(seen[0]!.method).toBe(method);
    expect(seen[0]!.url.pathname).toMatch(pattern);
  });
});
