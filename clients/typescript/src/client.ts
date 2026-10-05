import { HolmError } from "./errors.js";
import { decodeBase64, encodeBase64, Transport, type Query } from "./http.js";
import type {
  ActionBatch,
  App,
  Arrange,
  AwaitWindow,
  BatchResult,
  BoxView,
  ChangeRuntime,
  Cleared,
  ClipboardView,
  ConsoleRead,
  ConsoleView,
  Cookie,
  CreateBox,
  Element,
  ElementResult,
  Evaluate,
  Evaluated,
  ExecRequest,
  ExecResponse,
  ForkRequest,
  ForkResult,
  Found,
  Frame,
  Globbed,
  ImageList,
  ImageView,
  InstallApps,
  InstalledApps,
  Listing,
  LoadState,
  NewRuntime,
  NodeResult,
  OnElement,
  OnNode,
  PagePdf,
  PageShot,
  PageText,
  Point,
  PreparedImage,
  ReplayReport,
  RecordingView,
  RuntimeView,
  SaveState,
  Search,
  Selection,
  SetClipboard,
  SetCookies,
  Snapshot,
  Spec,
  StateView,
  Tab,
  TakeoverRequest,
  TakeoverView,
  TraceView,
  ViewersView,
  ViewerTicket,
  Window,
  WindowIcon,
  operations,
} from "./schema.js";

type QueryOf<Op extends keyof operations> = operations[Op]["parameters"] extends { query?: infer Q }
  ? NonNullable<Q>
  : never;

export type FrameQuery = QueryOf<"frame">;
export type GlobQuery = QueryOf<"glob">;
export type TraceQuery = QueryOf<"read_trace">;
export type PageQuery = QueryOf<"read_page">;
export type FindQuery = QueryOf<"find_elements">;
export type SnapshotQuery = QueryOf<"snapshot_page">;
export type SettleQuery = QueryOf<"on_element">;
export type TabQuery = QueryOf<"evaluate">;
export type CdpQuery = QueryOf<"token">;

export interface HolmOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface WaitOptions {
  wait?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface CreateOptions extends WaitOptions {
  idempotencyKey?: string;
}

export type ViewerMode = "view" | "control";

const STARTING_WAIT_MS = 30 * 60 * 1000;
const STARTING_POLL_MS = 1000;

export class Holm {
  readonly transport: Transport;
  readonly boxes: Boxes;
  readonly runtimes: Runtimes;
  readonly images: Images;
  readonly states: States;

  constructor(options: HolmOptions) {
    this.transport = new Transport(options);
    this.boxes = new Boxes(this.transport);
    this.runtimes = new Runtimes(this.transport);
    this.images = new Images(this.transport);
    this.states = new States(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  box(id: string): Box {
    return new Box(this.transport, id);
  }

  async health(): Promise<void> {
    const health = await this.transport.json<{ ok: boolean; service: string }>({ method: "GET", path: "/v1/health" });
    if (!health.ok || health.service !== "holm-server") {
      throw new Error(`something is answering at ${this.baseUrl}, and it is not a box server: ${health.service}`);
    }
  }

  catalog(): Promise<Record<string, App>> {
    return this.transport.json({ method: "GET", path: "/v1/catalog" });
  }
}

export class Boxes {
  constructor(private readonly transport: Transport) {}

  async list(): Promise<Box[]> {
    const listed = await this.transport.json<{ boxes: BoxView[] }>({ method: "GET", path: "/v1/boxes" });
    return listed.boxes.map((view) => new Box(this.transport, view.id, view));
  }

  async get(id: string): Promise<Box> {
    const box = new Box(this.transport, id);
    await box.refresh();
    return box;
  }

  async create(body: CreateBox, options: CreateOptions = {}): Promise<Box> {
    const view = await this.transport.json<BoxView>({
      method: "POST",
      path: "/v1/boxes",
      body,
      headers: idempotency(options.idempotencyKey),
      signal: options.signal,
    });
    const box = new Box(this.transport, view.id, view);
    if (options.wait !== false) await box.waitUntilStarted(options);
    return box;
  }
}

export class Box {
  readonly screens = new Map<number, Screen>();
  readonly files: Files;
  readonly page: Page;
  readonly cookies: Cookies;

  constructor(
    private readonly transport: Transport,
    readonly id: string,
    private last?: BoxView,
  ) {
    this.files = new Files(transport, this.path);
    this.page = new Page(transport, this.path);
    this.cookies = new Cookies(transport, this.path);
  }

  get path(): string {
    return `/v1/boxes/${encodeURIComponent(this.id)}`;
  }

  get view(): BoxView | undefined {
    return this.last;
  }

  screen(index = 0): Screen {
    let screen = this.screens.get(index);
    if (!screen) {
      screen = new Screen(this.transport, this.id, index);
      this.screens.set(index, screen);
    }
    return screen;
  }

  async refresh(): Promise<BoxView> {
    return this.keep(this.transport.json<BoxView>({ method: "GET", path: this.path }));
  }

  async waitUntilStarted(options: WaitOptions = {}): Promise<BoxView> {
    const timeoutMs = options.timeoutMs ?? STARTING_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    let view = this.last ?? (await this.refresh());

    while (view.state === "starting") {
      if (Date.now() >= deadline) {
        throw new HolmError(
          { code: "timeout", message: `box ${this.id} was still starting after ${timeoutMs} ms`, retryable: false },
          0,
        );
      }
      await sleep(options.pollMs ?? STARTING_POLL_MS, options.signal);
      view = await this.refresh();
    }

    if (view.state === "failed") {
      throw new HolmError(
        { code: "failed", message: view.reason ?? `box ${this.id} did not start`, retryable: false },
        0,
      );
    }
    return view;
  }

  pause(): Promise<BoxView> {
    return this.keep(this.transport.json({ method: "POST", path: `${this.path}/pause` }));
  }

  resume(): Promise<BoxView> {
    return this.keep(this.transport.json({ method: "POST", path: `${this.path}/resume` }));
  }

  stop(): Promise<BoxView> {
    return this.keep(this.transport.json({ method: "POST", path: `${this.path}/stop` }));
  }

  delete(): Promise<void> {
    return this.transport.nothing({
      method: "DELETE",
      path: this.path,
      headers: { "x-holm-confirm-delete": "yes" },
    });
  }

  async fork(body: ForkRequest = {}, options: CreateOptions = {}): Promise<{ box: Box; replay: ReplayReport }> {
    const forked = await this.transport.json<ForkResult>({
      method: "POST",
      path: `${this.path}/fork`,
      body,
      headers: idempotency(options.idempotencyKey),
      signal: options.signal,
    });
    const box = new Box(this.transport, forked.box.id, forked.box);
    if (options.wait !== false) await box.waitUntilStarted(options);
    return { box, replay: forked.replay };
  }

  exec(body: ExecRequest): Promise<ExecResponse> {
    return this.transport.json({ method: "POST", path: `${this.path}/exec`, body });
  }

  installApps(body: InstallApps): Promise<InstalledApps> {
    return this.transport.json({ method: "POST", path: `${this.path}/apps`, body });
  }

  trace(query: TraceQuery = {}): Promise<TraceView> {
    return this.transport.json({ method: "GET", path: `${this.path}/trace`, query: query as Query });
  }

  traceFrame(hash: string): Promise<Uint8Array> {
    return this.transport.bytes({ method: "GET", path: `${this.path}/trace/frames/${encodeURIComponent(hash)}` });
  }

  saveState(body: SaveState): Promise<StateView> {
    return this.transport.json({ method: "POST", path: `${this.path}/state/save`, body });
  }

  loadState(body: LoadState): Promise<StateView> {
    return this.transport.json({ method: "POST", path: `${this.path}/state/load`, body });
  }

  private async keep(view: Promise<BoxView>): Promise<BoxView> {
    this.last = await view;
    return this.last;
  }
}

export class Screen {
  readonly windows: Windows;

  constructor(
    private readonly transport: Transport,
    readonly boxId: string,
    readonly index: number,
  ) {
    this.windows = new Windows(transport, this.path);
  }

  get path(): string {
    return `/v1/boxes/${encodeURIComponent(this.boxId)}/screens/${this.index}`;
  }

  act(batch: ActionBatch, options: { idempotencyKey?: string } = {}): Promise<BatchResult> {
    return this.transport.json({
      method: "POST",
      path: `${this.path}/actions`,
      body: batch,
      headers: idempotency(options.idempotencyKey),
    });
  }

  frame(query: FrameQuery = {}): Promise<Frame> {
    return this.transport.json({ method: "GET", path: `${this.path}/frame`, query: query as Query });
  }

  async screenshot(query: FrameQuery = {}): Promise<Uint8Array | undefined> {
    const frame = await this.frame(query);
    return frame.png_base64 ? decodeBase64(frame.png_base64) : undefined;
  }

  cursor(): Promise<Point> {
    return this.transport.json({ method: "GET", path: `${this.path}/cursor` });
  }

  node(body: OnNode): Promise<NodeResult> {
    return this.transport.json({ method: "POST", path: `${this.path}/desktop/node`, body });
  }

  clipboard(selection?: Selection): Promise<ClipboardView> {
    return this.transport.json({ method: "GET", path: `${this.path}/clipboard`, query: { selection } });
  }

  setClipboard(body: SetClipboard): Promise<void> {
    return this.transport.nothing({ method: "PUT", path: `${this.path}/clipboard`, body });
  }

  takeover(body: TakeoverRequest = {}): Promise<TakeoverView> {
    return this.transport.json({ method: "POST", path: `${this.path}/takeover`, body });
  }

  endTakeover(): Promise<void> {
    return this.transport.nothing({ method: "DELETE", path: `${this.path}/takeover` });
  }

  viewers(): Promise<ViewersView> {
    return this.transport.json({ method: "GET", path: `${this.path}/viewers` });
  }

  viewerToken(): Promise<ViewerTicket> {
    return this.transport.json({ method: "POST", path: `${this.path}/viewer/ticket` });
  }

  recording(): Promise<RecordingView> {
    return this.transport.json({ method: "GET", path: `${this.path}/recording` });
  }

  startRecording(fps?: number): Promise<RecordingView> {
    return this.transport.json({ method: "POST", path: `${this.path}/recording`, body: { fps } });
  }

  stopRecording(): Promise<RecordingView> {
    return this.transport.json({ method: "DELETE", path: `${this.path}/recording` });
  }
}

export function viewerSocketUrl(
  baseUrl: string,
  boxId: string,
  screen: number,
  token: ViewerTicket,
  mode: ViewerMode = "view",
): string {
  const direct = mode === "control" ? token.control_socket : token.view_socket;
  if (direct) return direct;
  const url = new URL(
    `${baseUrl.replace(/\/+$/, "")}/v1/boxes/${encodeURIComponent(boxId)}/screens/${screen}/viewer/socket`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", token.ticket);
  url.searchParams.set("mode", mode);
  return url.toString();
}

export class Windows {
  constructor(
    private readonly transport: Transport,
    private readonly screenPath: string,
  ) {}

  list(): Promise<Window[]> {
    return this.transport.json({ method: "GET", path: `${this.screenPath}/windows` });
  }

  active(): Promise<Window | null> {
    return this.transport.json({ method: "GET", path: `${this.screenPath}/windows/active` });
  }

  waitFor(body: AwaitWindow): Promise<Window> {
    return this.transport.json({ method: "POST", path: `${this.screenPath}/windows/wait`, body });
  }

  focus(id: string): Promise<void> {
    return this.transport.nothing({ method: "POST", path: `${this.at(id)}/focus` });
  }

  icon(id: string): Promise<WindowIcon> {
    return this.transport.json({ method: "GET", path: `${this.at(id)}/icon` });
  }

  arrange(id: string, body: Arrange): Promise<Window> {
    return this.transport.json({ method: "POST", path: `${this.at(id)}/arrange`, body });
  }

  close(id: string): Promise<void> {
    return this.transport.nothing({ method: "DELETE", path: this.at(id) });
  }

  private at(id: string): string {
    return `${this.screenPath}/windows/${encodeURIComponent(id)}`;
  }
}

export class Files {
  constructor(
    private readonly transport: Transport,
    private readonly boxPath: string,
  ) {}

  async read(path: string): Promise<Uint8Array> {
    const read = await this.transport.json<{ contents_base64: string }>({
      method: "GET",
      path: `${this.boxPath}/files`,
      query: { path },
    });
    return decodeBase64(read.contents_base64);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  write(path: string, contents: Uint8Array | string): Promise<void> {
    const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    return this.transport.nothing({
      method: "PUT",
      path: `${this.boxPath}/files`,
      body: { path, contents_base64: encodeBase64(bytes) },
    });
  }

  list(path: string): Promise<Listing> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/files/list`, query: { path } });
  }

  grep(search: Search): Promise<Found> {
    return this.transport.json({ method: "POST", path: `${this.boxPath}/files/grep`, body: search });
  }

  glob(query: GlobQuery): Promise<Globbed> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/files/glob`, query: query as Query });
  }
}

export class Page {
  constructor(
    private readonly transport: Transport,
    private readonly boxPath: string,
  ) {}

  tabs(): Promise<Tab[]> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/pages` });
  }

  focusTab(tab: string): Promise<void> {
    return this.transport.nothing({ method: "POST", path: `${this.boxPath}/pages/${encodeURIComponent(tab)}/focus` });
  }

  closeTab(tab: string): Promise<void> {
    return this.transport.nothing({ method: "DELETE", path: `${this.boxPath}/pages/${encodeURIComponent(tab)}` });
  }

  read(query: PageQuery = {}): Promise<PageText> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/page`, query: query as Query });
  }

  find(query: FindQuery = {}): Promise<Element[]> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/page/find`, query: query as Query });
  }

  snapshot(query: SnapshotQuery = {}): Promise<Snapshot> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/page/snapshot`, query: query as Query });
  }

  element(body: OnElement, query: SettleQuery = {}): Promise<ElementResult> {
    return this.transport.json({
      method: "POST",
      path: `${this.boxPath}/page/element`,
      body,
      query: query as Query,
    });
  }

  evaluate(body: Evaluate, query: TabQuery = {}): Promise<Evaluated> {
    return this.transport.json({
      method: "POST",
      path: `${this.boxPath}/page/evaluate`,
      body,
      query: query as Query,
    });
  }

  async screenshot(body: PageShot = {}): Promise<Uint8Array> {
    const taken = await this.transport.json<{ image_base64: string }>({
      method: "POST",
      path: `${this.boxPath}/page/screenshot`,
      body,
    });
    return decodeBase64(taken.image_base64);
  }

  async pdf(body: PagePdf = {}): Promise<Uint8Array> {
    const printed = await this.transport.json<{ pdf_base64?: string | null }>({
      method: "POST",
      path: `${this.boxPath}/page/pdf`,
      body,
    });
    return decodeBase64(printed.pdf_base64 ?? "");
  }

  console(body: ConsoleRead = {}): Promise<ConsoleView> {
    return this.transport.json({ method: "POST", path: `${this.boxPath}/page/console`, body });
  }

  cdp(query: CdpQuery = {}): Promise<{ url: string } & Record<string, unknown>> {
    return this.transport.json({ method: "POST", path: `${this.boxPath}/cdp`, query: query as Query });
  }
}

export class Cookies {
  constructor(
    private readonly transport: Transport,
    private readonly boxPath: string,
  ) {}

  list(url?: string): Promise<Cookie[]> {
    return this.transport.json({ method: "GET", path: `${this.boxPath}/cookies`, query: { url } });
  }

  set(body: SetCookies): Promise<Cookie[]> {
    return this.transport.json({ method: "POST", path: `${this.boxPath}/cookies`, body });
  }

  clear(url?: string): Promise<Cleared> {
    return this.transport.json({ method: "DELETE", path: `${this.boxPath}/cookies`, query: { url } });
  }
}

export class Runtimes {
  constructor(private readonly transport: Transport) {}

  async list(): Promise<RuntimeView[]> {
    const listed = await this.transport.json<{ runtimes: RuntimeView[] }>({ method: "GET", path: "/v1/runtimes" });
    return listed.runtimes;
  }

  get(name: string): Promise<RuntimeView> {
    return this.transport.json({ method: "GET", path: `/v1/runtimes/${encodeURIComponent(name)}` });
  }

  add(body: NewRuntime): Promise<RuntimeView> {
    return this.transport.json({ method: "POST", path: "/v1/runtimes", body });
  }

  change(name: string, body: ChangeRuntime): Promise<RuntimeView> {
    return this.transport.json({ method: "PATCH", path: `/v1/runtimes/${encodeURIComponent(name)}`, body });
  }

  remove(name: string): Promise<void> {
    return this.transport.nothing({ method: "DELETE", path: `/v1/runtimes/${encodeURIComponent(name)}` });
  }
}

export class Images {
  constructor(private readonly transport: Transport) {}

  async list(runtime?: string): Promise<ImageView[]> {
    const path = runtime ? `/v1/runtimes/${encodeURIComponent(runtime)}/images` : "/v1/images";
    const listed = await this.transport.json<ImageList>({ method: "GET", path });
    return listed.images;
  }

  status(runtime: string, digest: string): Promise<PreparedImage> {
    return this.transport.json({
      method: "GET",
      path: `/v1/runtimes/${encodeURIComponent(runtime)}/images/${encodeURIComponent(digest)}`,
    });
  }

  async prepare(runtime: string, spec: Spec, options: WaitOptions = {}): Promise<PreparedImage> {
    let prepared = await this.transport.json<PreparedImage>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(runtime)}/image`,
      body: { spec },
      signal: options.signal,
    });
    if (options.wait === false) return prepared;

    const digest = prepared.spec_digest;
    const timeoutMs = options.timeoutMs ?? STARTING_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    while (prepared.state === "building" && digest) {
      if (Date.now() >= deadline) {
        throw new HolmError(
          { code: "timeout", message: `the image was still building after ${timeoutMs} ms`, retryable: false },
          0,
        );
      }
      await sleep(options.pollMs ?? STARTING_POLL_MS, options.signal);
      prepared = await this.status(runtime, digest);
    }

    if (prepared.state === "failed") {
      throw new HolmError({ code: "failed", message: prepared.reason ?? "the image did not build", retryable: false }, 0);
    }
    return prepared;
  }

  forget(runtime: string, digest: string): Promise<void> {
    return this.transport.nothing({
      method: "DELETE",
      path: `/v1/runtimes/${encodeURIComponent(runtime)}/images/${encodeURIComponent(digest)}`,
    });
  }
}

export class States {
  constructor(private readonly transport: Transport) {}

  list(): Promise<string[]> {
    return this.transport.json({ method: "GET", path: "/v1/states" });
  }

  forget(name: string): Promise<void> {
    return this.transport.nothing({ method: "DELETE", path: `/v1/states/${encodeURIComponent(name)}` });
  }
}

function idempotency(key: string | undefined): Record<string, string> | undefined {
  return key ? { "idempotency-key": key } : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
