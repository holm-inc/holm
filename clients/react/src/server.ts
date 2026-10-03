import { HolmError, viewerSocketUrl, type Holm } from "@holm/client";
import { OPS, type Call, type Op } from "./protocol.js";

export type { Call, Op } from "./protocol.js";

export interface ScreenHandlerOptions {
  holm: Holm;
  authorize: (request: Request, call: Call) => boolean | Promise<boolean>;
  socketBase?: string;
}

export function createScreenHandler(options: ScreenHandlerOptions): (request: Request) => Promise<Response> {
  const socketBase = options.socketBase ?? options.holm.baseUrl;

  return async (request) => {
    if (request.method !== "POST") return refuse(405, "bad_request", "this handler takes POST");

    let call: Call;
    try {
      call = parse(await request.json());
    } catch (error) {
      return refuse(400, "bad_request", error instanceof Error ? error.message : "the body is not a screen call");
    }

    if (!(await options.authorize(request, call))) {
      return refuse(403, "denied", "this caller may not use this screen");
    }

    const screen = options.holm.box(call.box_id).screen(call.screen);
    try {
      return answer(await run(call, screen, socketBase));
    } catch (error) {
      if (error instanceof HolmError) {
        const status = error.status >= 400 ? error.status : 502;
        return refuse(status, error.code, error.message, error.retryable);
      }
      return refuse(502, "unavailable", error instanceof Error ? error.message : String(error), true);
    }
  };
}

async function run(call: Call, screen: ReturnType<ReturnType<Holm["box"]>["screen"]>, socketBase: string) {
  switch (call.op) {
    case "connect": {
      const { mode } = call as Call<"connect">;
      const token = await screen.viewerToken();
      return {
        url: viewerSocketUrl(socketBase, call.box_id, call.screen, token, mode),
        expires_at_ms: token.expires_at_ms,
      };
    }
    case "status": {
      const [viewers, recording] = await Promise.all([screen.viewers(), screen.recording()]);
      return { viewers, recording };
    }
    case "takeover":
      return screen.takeover();
    case "give_back":
      await screen.endTakeover();
      return {};
    case "start_recording":
      return screen.startRecording((call as Call<"start_recording">).fps);
    case "stop_recording":
      return screen.stopRecording();
    case "windows":
      return screen.windows.list();
    case "focus_window":
      await screen.windows.focus((call as Call<"focus_window">).window);
      return {};
    case "close_window":
      await screen.windows.close((call as Call<"close_window">).window);
      return {};
    case "clipboard":
      return screen.clipboard();
    case "set_clipboard":
      await screen.setClipboard({ text: (call as Call<"set_clipboard">).text });
      return {};
  }
}

function parse(body: unknown): Call {
  if (typeof body !== "object" || body === null) throw new Error("the body is not an object");
  const call = body as Record<string, unknown>;
  if (typeof call.op !== "string" || !OPS.includes(call.op as Op)) throw new Error(`no such op: ${String(call.op)}`);
  if (typeof call.box_id !== "string" || call.box_id === "") throw new Error("box_id is missing");
  if (typeof call.screen !== "number" || !Number.isInteger(call.screen) || call.screen < 0) {
    throw new Error("screen is not a screen index");
  }
  if (call.op === "connect" && call.mode !== "view" && call.mode !== "control") {
    throw new Error("mode is view or control");
  }
  if ((call.op === "focus_window" || call.op === "close_window") && typeof call.window !== "string") {
    throw new Error("window is missing");
  }
  if (call.op === "set_clipboard" && typeof call.text !== "string") throw new Error("text is missing");
  if (call.op === "start_recording" && call.fps !== undefined && typeof call.fps !== "number") {
    throw new Error("fps is not a number");
  }
  return call as unknown as Call;
}

function answer(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function refuse(status: number, code: string, message: string, retryable = false): Response {
  return new Response(JSON.stringify({ code, message, retryable }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
