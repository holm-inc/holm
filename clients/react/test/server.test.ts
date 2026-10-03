import { Holm } from "@holm/client";
import { describe, expect, it } from "vitest";
import { createScreenHandler } from "../src/server.js";

function holm(answer: (url: URL, method: string) => Response) {
  const seen: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method} ${url.pathname}`);
    return answer(url, init?.method ?? "GET");
  };
  return { seen, holm: new Holm({ baseUrl: "https://api.example.com", apiKey: "smk_test", fetch }) };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const post = (body: unknown) =>
  new Request("https://app.example.com/api/screen", { method: "POST", body: JSON.stringify(body) });

describe("screen handler", () => {
  it("hands out a socket address and never the key", async () => {
    const { holm: client } = holm(() => json({ ticket: "t1", expires_at_ms: 9 }));
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    const answer = await handle(post({ op: "connect", box_id: "box_1", screen: 0, mode: "view" }));
    const body = await answer.json();
    expect(body).toEqual({
      url: "wss://api.example.com/v1/boxes/box_1/screens/0/viewer/socket?ticket=t1&mode=view",
      expires_at_ms: 9,
    });
    expect(JSON.stringify(body)).not.toContain("smk_");
  });

  it("asks authorize before it calls the server", async () => {
    const { seen, holm: client } = holm(() => json({}));
    const handle = createScreenHandler({ holm: client, authorize: (_, call) => call.box_id === "mine" });
    const answer = await handle(post({ op: "takeover", box_id: "theirs", screen: 0 }));
    expect(answer.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("refuses a call it does not know", async () => {
    const { holm: client } = holm(() => json({}));
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    expect((await handle(post({ op: "exec", box_id: "b", screen: 0 }))).status).toBe(400);
    expect((await handle(post({ op: "connect", box_id: "b", screen: -1, mode: "view" }))).status).toBe(400);
    expect((await handle(post({ op: "connect", box_id: "b", screen: 0, mode: "drive" }))).status).toBe(400);
    expect((await handle(new Request("https://app.example.com/", { method: "GET" }))).status).toBe(405);
  });

  it("joins viewers and recording into one status", async () => {
    const { holm: client } = holm((url) =>
      url.pathname.endsWith("/viewers")
        ? json({ watching: 1, driving: 0, person_driving: false, taken_over: false })
        : json({ recording: true, path: "/tmp/r.mp4" }),
    );
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    const body = await (await handle(post({ op: "status", box_id: "b", screen: 0 }))).json();
    expect(body).toMatchObject({ viewers: { watching: 1 }, recording: { recording: true } });
  });

  it("names the active window with the list", async () => {
    const { holm: client } = holm((url) =>
      url.pathname.endsWith("/active") ? json({ id: "w2", title: "T" }) : json([{ id: "w1", title: "A" }, { id: "w2", title: "T" }]),
    );
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    const body = await (await handle(post({ op: "windows", box_id: "b", screen: 0 }))).json();
    expect(body).toEqual({ windows: [{ id: "w1", title: "A" }, { id: "w2", title: "T" }], active: "w2" });
  });

  it("passes a refusal through", async () => {
    const { holm: client } = holm(() => json({ code: "not_found", message: "no box b", retryable: false }, 404));
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    const answer = await handle(post({ op: "windows", box_id: "b", screen: 0 }));
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ code: "not_found", message: "not_found: no box b", retryable: false });
  });

  it("maps each op to its route", async () => {
    const { seen, holm: client } = holm(() => json({}));
    const handle = createScreenHandler({ holm: client, authorize: () => true });
    const calls: [Record<string, unknown>, string][] = [
      [{ op: "takeover" }, "POST /v1/boxes/b/screens/1/takeover"],
      [{ op: "give_back" }, "DELETE /v1/boxes/b/screens/1/takeover"],
      [{ op: "start_recording", fps: 10 }, "POST /v1/boxes/b/screens/1/recording"],
      [{ op: "stop_recording" }, "DELETE /v1/boxes/b/screens/1/recording"],
      [{ op: "windows" }, "GET /v1/boxes/b/screens/1/windows"],
      [{ op: "windows" }, "GET /v1/boxes/b/screens/1/windows/active"],
      [{ op: "focus_window", window: "w1" }, "POST /v1/boxes/b/screens/1/windows/w1/focus"],
      [{ op: "close_window", window: "w1" }, "DELETE /v1/boxes/b/screens/1/windows/w1"],
      [{ op: "clipboard" }, "GET /v1/boxes/b/screens/1/clipboard"],
      [{ op: "set_clipboard", text: "x" }, "PUT /v1/boxes/b/screens/1/clipboard"],
    ];
    const sent = calls.filter(([call], i) => !(call.op === "windows" && calls[i - 1]?.[0].op === "windows"));
    for (const [call] of sent) await handle(post({ ...call, box_id: "b", screen: 1 }));
    expect([...seen].sort()).toEqual(calls.map(([, route]) => route).sort());
  });
});
