# @holm/react

React components that show a holm box's screen and let a person drive it.

The browser never holds an API key. Your server holds the key and serves one endpoint; the components call that endpoint, and it calls the holm API.

## Server

`createScreenHandler` returns a standard `(Request) => Promise<Response>` handler. `authorize` is required: it decides which caller may use which box.

```ts
// app/api/screen/route.ts (Next.js)
import { Holm } from "@holm/client";
import { createScreenHandler } from "@holm/react/server";

const holm = new Holm({ baseUrl: "https://api.holm.computer", apiKey: process.env.HOLM_API_KEY });

export const POST = createScreenHandler({
  holm,
  authorize: async (request, call) => userOwnsBox(request, call.box_id),
});
```

`call.op` names what the page asks for, so `authorize` can also refuse a single action, such as `takeover` for a watch-only user. Pass `socketBase` when the browser reaches the holm server at another address than your server does.

## Page

```tsx
import { HolmViewer, screenController } from "@holm/react";
import "@holm/react/styles.css";

const controller = screenController({ endpoint: "/api/screen", boxId });

<HolmViewer controller={controller} />;
```

`HolmViewer` has the screen and a panel: take over and give back, start and stop recording, the window list (focus, close), the clipboard, the viewer count, and full screen. `readOnly` shows the screen with no controls.

While the person drives, the server refuses API input to the screen, so the panel sends the clipboard over the screen connection and disables the window actions; the person can use the screen directly.

## Parts

- `HolmScreen` is the screen alone. Set `mode` to `"view"` or `"control"`.
- `useScreen(controller)` holds the state and actions of the panel, for a panel of your own.
- Override the `--holm-*` CSS variables on `.holm-viewer` to change the colors.

## Bundling

noVNC uses top-level `await`, so the build target must allow it (ES2022 or later). In Vite, set `build.target` and `optimizeDeps.esbuildOptions.target` to `"esnext"`. The screen loads noVNC only in the browser, so the components render on a server without errors.
