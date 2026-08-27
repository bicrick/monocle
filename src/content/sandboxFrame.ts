/**
 * Page-injected Chrome sandbox frame. Untrusted model JS evals here only.
 * Host DOM work stays in the content script via postMessage.
 */

const FRAME_ID = "monacle-runtime-frame";
const OVERLAY_ID = "monacle-overlay";

export interface SandboxHostHandlers {
  query: (selector: string) => unknown[];
  insert: (
    html: string,
    opts: { selector: string; position?: string },
  ) => unknown[];
  css: (text: string) => void;
  media: () => unknown[];
  viewport: () => { width: number; height: number };
}

export interface SerializedNode {
  tag: string;
  id: string;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
}

let token = "";
let handlers: SandboxHostHandlers | null = null;
let pumpId = 0;
let listening = false;
let queries: Record<string, SerializedNode[]> = {};

function sandboxUrl(): string {
  return chrome.runtime.getURL("src/sandbox/sandbox.html");
}

function overlayHost(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

function frameEl(): HTMLIFrameElement | null {
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
}

function postToFrame(payload: Record<string, unknown>): void {
  const frame = frameEl();
  const win = frame?.contentWindow;
  if (!win) return;
  win.postMessage({ source: "monacle-host", token, ...payload }, "*");
}

function pumpState(): void {
  if (!handlers) return;
  postToFrame({
    type: "monacle-host-state",
    media: handlers.media(),
    viewport: handlers.viewport(),
    queries,
  });
}

function startPump(): void {
  stopPump();
  const tick = () => {
    pumpState();
    pumpId = requestAnimationFrame(tick);
  };
  pumpId = requestAnimationFrame(tick);
}

function stopPump(): void {
  if (pumpId) {
    cancelAnimationFrame(pumpId);
    pumpId = 0;
  }
}

function onMessage(event: MessageEvent): void {
  const frame = frameEl();
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.source !== "monacle-sandbox") return;
  if (data.token && data.token !== token) return;

  if (data.type === "monacle-host-call" && handlers) {
    const method = data.method as string;
    const args = Array.isArray(data.args) ? data.args : [];
    try {
      if (method === "query" && typeof args[0] === "string") {
        queries[args[0]] = handlers.query(args[0]) as SerializedNode[];
        pumpState();
      } else if (method === "insert") {
        handlers.insert(String(args[0] ?? ""), (args[1] as { selector: string }) ?? {
          selector: "body",
        });
      } else if (method === "css") {
        handlers.css(String(args[0] ?? ""));
      }
    } catch (err) {
      console.warn(
        "[Monacle] sandbox host call failed",
        err instanceof Error ? err.message : err,
      );
    }
    return;
  }

  if (data.type === "monacle-runtime-error") {
    console.warn("[Monacle] sandbox runtime:", data.message);
  }
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", onMessage);
}

function createFrame(host: HTMLElement): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    border: "0",
    background: "transparent",
    pointerEvents: "none",
    zIndex: "1",
  });
  host.appendChild(frame);
  return frame;
}

function waitReady(frame: HTMLIFrameElement, session: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReady);
      reject(new Error("Sandbox frame did not become ready"));
    }, 4000);

    function onReady(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "monacle-sandbox") return;
      if (data.type !== "monacle-ready") return;
      window.removeEventListener("message", onReady);
      window.clearTimeout(timer);
      if (token !== session) {
        reject(new Error("Sandbox session replaced"));
        return;
      }
      resolve();
    }

    window.addEventListener("message", onReady);
  });
}

export function stopSandboxRuntime(): void {
  stopPump();
  handlers = null;
  queries = {};
  const frame = frameEl();
  if (frame?.contentWindow && token) {
    try {
      frame.contentWindow.postMessage(
        { source: "monacle-host", type: "monacle-runtime-stop", token },
        "*",
      );
    } catch {
      // frame gone
    }
  }
  frame?.remove();
  token = "";
}

export async function startSandboxRuntime(
  code: string,
  next: SandboxHostHandlers,
): Promise<void> {
  stopSandboxRuntime();
  const host = overlayHost();
  if (!host) {
    throw new Error("Overlay host missing — cannot start sandboxed runtime");
  }

  ensureListener();
  token = `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  handlers = next;
  queries = {};

  const frame = createFrame(host);
  const ready = waitReady(frame, token);
  frame.src = sandboxUrl();
  await ready;
  startPump();
  pumpState();
  postToFrame({ type: "monacle-runtime-start", code });
}
