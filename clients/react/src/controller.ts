import { HolmError, UnreadableError, type ErrorBody } from "@holm/client";
import type { Op, Ops } from "./protocol.js";

export interface ScreenController {
  readonly key: string;
  call<O extends Op>(op: O, args: Ops[O]["args"], signal?: AbortSignal): Promise<Ops[O]["answer"]>;
}

export interface ScreenControllerOptions {
  endpoint: string;
  boxId: string;
  screen?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export function screenController(options: ScreenControllerOptions): ScreenController {
  const screen = options.screen ?? 0;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    key: `${options.endpoint}|${options.boxId}|${screen}`,
    async call(op, args, signal) {
      const response = await fetcher(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify({ ...args, op, box_id: options.boxId, screen }),
        signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new UnreadableError(response.status, text);
      }
      if (!response.ok) throw new HolmError(body as ErrorBody, response.status);
      return body as never;
    },
  };
}
