declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[]; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    clipboardPasteFrom(text: string): void;
  }
}
