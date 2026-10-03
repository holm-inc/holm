# @holm/client

A TypeScript client for the holm box API. It has no runtime dependencies and runs anywhere `fetch` does: Node 18+, browsers, Deno, Bun and edge runtimes.

```ts
import { Holm } from "@holm/client";

const holm = new Holm({ baseUrl: "https://api.holm.computer", apiKey: process.env.HOLM_API_KEY });

const box = await holm.boxes.create({
  spec: { desktop: { server: "x11", width: 1280, height: 800 } },
  placement: { runtime: "docker" },
});

const screen = box.screen(0);
await screen.act({ actions: [{ type: "click", at: { x: 640, y: 400 } }] });
const png = await screen.screenshot();

await box.files.write("/tmp/notes.txt", "hello");
const ran = await box.exec({ argv: ["cat", "/tmp/notes.txt"] });

await box.delete();
```

`boxes.create` and `box.fork` return once the box has started; pass `{ wait: false }` to return at once.

## Errors

A refusal from the server is a `HolmError` with `code`, `message`, `retryable` and the HTTP `status`. A failed connection is a `TransportError`, and an answer that is not JSON is an `UnreadableError`.

## Viewer

Do not send an API key to a browser. Get a short-lived token on your server and give only that to the page:

```ts
const token = await holm.box(id).screen(0).viewerToken();
const url = viewerSocketUrl(holm.baseUrl, id, 0, token, "control");
```

`@holm/react` renders the screen from this token.

## Types

`src/schema.ts` is generated from `clients/openapi.json` with `npm run generate`. Do not edit it by hand.
