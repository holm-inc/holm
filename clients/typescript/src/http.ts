import { HolmError, TransportError, UnreadableError } from "./errors.js";
import type { ErrorBody } from "./schema.js";

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface Request {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Query | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
  headers?: Record<string, string> | undefined;
}

export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
  }

  url(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async json<T>(request: Request): Promise<T> {
    const response = await this.send(request);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UnreadableError(response.status, text);
    }
  }

  async nothing(request: Request): Promise<void> {
    await this.send(request);
  }

  async bytes(request: Request): Promise<Uint8Array> {
    const response = await this.send(request);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async send(request: Request): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers, ...request.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (request.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetcher(this.url(request.path, request.query), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new TransportError(error instanceof Error ? error.message : String(error), { cause: error });
    }

    if (response.ok) return response;

    const text = await response.text().catch(() => "");
    let body: ErrorBody | undefined;
    try {
      body = JSON.parse(text) as ErrorBody;
    } catch {}
    if (body && typeof body.code === "string" && typeof body.message === "string") {
      throw new HolmError(body, response.status);
    }
    throw new UnreadableError(response.status, text);
  }
}

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
