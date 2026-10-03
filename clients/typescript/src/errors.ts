import type { ErrorBody, ErrorCode } from "./schema.js";

export class HolmError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(body: ErrorBody, status: number) {
    super(`${body.code}: ${body.message}`);
    this.name = "HolmError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.status = status;
  }
}

export class TransportError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

export class UnreadableError extends Error {
  readonly retryable = false;
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`${status} answered with ${body}`);
    this.name = "UnreadableError";
    this.status = status;
    this.body = body;
  }
}
