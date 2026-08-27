/**
 * Hidden Chrome sandbox frame. Untrusted model JS evals there only.
 * The content script owns query / insert / canvas / rAF / media.
 */

import {
  FRAME_ID,
  HOST_SOURCE,
  SANDBOX_SOURCE,
  dispatchHostCall,
  type SandboxHostHandlers,
} from "./sandboxProtocol";

export type { SandboxHostHandlers, SerializedNode } from "./sandboxProtocol";

const OVERLAY_ID = "monacle-overlay";
/** How often to push media/viewport/query snapshots (raf ticks stay every frame). */
const HOST_STATE_INTERVAL_MS = 66;

let token = "";
let handlers: SandboxHostHandlers | null = null;
let pumpId = 0;
let listening = false;
let queries: Record<string, unknown[]> = {};
let displayCanvas: HTMLCanvasElement | null = null;
let lastHostStateAt = 0;
let lastHostStateKey = "";
/** Bumped on every start/stop so in-flight starts can bail out. */
let startGeneration = 0;
let startChain: Promise<void> = Promise.resolve();

function sandboxUrl(): string {
  return chrome.runtime.getURL("src/sandbox/sandbox.html");
}

function frameEl(): HTMLIFrameElement | null {
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
}

function postToFrame(
  payload: Record<string, unknown>,
  transfer: Transferable[] = [],
): void {
  const frame = frameEl();
  const win = frame?.contentWindow;
  if (!win) return;
  win.postMessage({ source: HOST_SOURCE, token, ...payload }, "*", transfer);
}

function hostStatePayload(): Record<string, unknown> {
  if (!handlers) return {};
  return {
    media: handlers.media(),
    viewport: handlers.viewport(),
    queries,
  };
}

function hostStateKey(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(Date.now());
  }
}

/** Push media/viewport/queries only when changed, rate-limited to ~15Hz. */
function pumpState(force = false): void {
  if (!handlers) return;
  const now = performance.now();
  const payload = hostStatePayload();
  const key = hostStateKey(payload);
  if (!force) {
    if (key === lastHostStateKey) return;
    if (now - lastHostStateAt < HOST_STATE_INTERVAL_MS) return;
  }
  lastHostStateKey = key;
  lastHostStateAt = now;
  postToFrame({
    type: "monacle-host-state",
    ...payload,
  });
}

function startPump(): void {
  stopPump();
  lastHostStateAt = 0;
  lastHostStateKey = "";
  const tick = (time: number) => {
    pumpState(false);
    postToFrame({ type: "monacle-raf-tick", time });
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
  if (!data || data.source !== SANDBOX_SOURCE) return;
  if (data.token && data.token !== token) return;

  if (data.type === "monacle-host-call" && handlers) {
    const args = Array.isArray(data.args) ? data.args : [];
    try {
      const result = dispatchHostCall(String(data.method ?? ""), args, handlers);
      if (result.kind === "query") {
        const prev = JSON.stringify(queries[result.selector] ?? null);
        const next = JSON.stringify(result.nodes);
        queries[result.selector] = result.nodes;
        if (prev !== next) pumpState(true);
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

function createFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  Object.assign(frame.style, {
    position: "fixed",
    width: "0",
    height: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
    left: "0",
    top: "0",
  });
  document.documentElement.appendChild(frame);
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
      if (!data || data.source !== SANDBOX_SOURCE) return;
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

function releaseDisplayCanvas(): void {
  displayCanvas?.remove();
  displayCanvas = null;
}

/** Tear down frame/canvas/pump without bumping startGeneration. */
function teardownSandbox(): void {
  stopPump();
  handlers = null;
  queries = {};
  lastHostStateKey = "";
  lastHostStateAt = 0;
  const frame = frameEl();
  if (frame?.contentWindow && token) {
    try {
      frame.contentWindow.postMessage(
        { source: HOST_SOURCE, type: "monacle-runtime-stop", token },
        "*",
      );
    } catch {
      // frame gone
    }
  }
  frame?.remove();
  releaseDisplayCanvas();
  token = "";
}

export function stopSandboxRuntime(): void {
  startGeneration += 1;
  teardownSandbox();
}

function transferCanvas(canvas: HTMLCanvasElement): OffscreenCanvas {
  try {
    return canvas.transferControlToOffscreen();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    if (
      name !== "InvalidStateError" &&
      !/already transferred|detached/i.test(message)
    ) {
      throw err;
    }
    // Already transferred — replace with a fresh canvas and retry once.
    const fresh = document.createElement("canvas");
    fresh.setAttribute("data-monacle-canvas", "1");
    fresh.width = Math.max(1, canvas.width || window.innerWidth || 1);
    fresh.height = Math.max(1, canvas.height || window.innerHeight || 1);
    Object.assign(fresh.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "0",
    });
    canvas.replaceWith(fresh);
    displayCanvas = fresh;
    return fresh.transferControlToOffscreen();
  }
}

async function startSandboxRuntimeInner(
  code: string,
  next: SandboxHostHandlers,
  generation: number,
): Promise<void> {
  if (generation !== startGeneration) return;

  teardownSandbox();
  if (generation !== startGeneration) return;

  if (!document.getElementById(OVERLAY_ID)) {
    throw new Error("Overlay host missing — cannot start sandboxed runtime");
  }

  ensureListener();
  token = `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  handlers = next;
  queries = {};

  const canvas = next.canvas();
  displayCanvas = canvas;
  // Do not touch canvas.width/height after this transfer — the placeholder is
  // size-locked. The sandbox only commits OffscreenCanvas size on real changes.
  const offscreen = transferCanvas(canvas);

  if (generation !== startGeneration) return;

  const frame = createFrame();
  const session = token;
  const ready = waitReady(frame, session);
  frame.src = sandboxUrl();
  await ready;

  if (generation !== startGeneration || token !== session) {
    frame.remove();
    return;
  }

  startPump();
  postToFrame(
    {
      type: "monacle-runtime-start",
      code,
      canvas: offscreen,
      ...hostStatePayload(),
    },
    [offscreen],
  );
}

/**
 * Serialize starts so we never transfer two OffscreenCanvases concurrently.
 * A newer start or stop bumps startGeneration and cancels in-flight work.
 */
export function startSandboxRuntime(
  code: string,
  next: SandboxHostHandlers,
): Promise<void> {
  const generation = ++startGeneration;
  const run = startChain.then(() => {
    if (generation !== startGeneration) return;
    return startSandboxRuntimeInner(code, next, generation);
  });
  startChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
