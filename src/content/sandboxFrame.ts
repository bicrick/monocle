/**
 * Hidden Chrome sandbox frame. Untrusted model JS evals there only.
 * The content script owns query / insert / create / rAF / media.
 * Canvas is NOT transferred — motion uses host DOM nodes + style.
 */

import { isExtensionContextValid } from "./extensionContext";
import { reportRuntimeError } from "./runtimeErrors";
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
let lastHostStateAt = 0;
let lastHostStateKey = "";
/** Bumped on every start/stop so in-flight starts can bail out. */
let startGeneration = 0;
let startChain: Promise<void> = Promise.resolve();
let deadReported = false;
let sandboxHtmlCache: string | null = null;
let mountChain: Promise<HTMLIFrameElement | null> = Promise.resolve(null);

async function loadSandboxHtml(): Promise<string> {
  if (sandboxHtmlCache) return sandboxHtmlCache;
  if (!isExtensionContextValid()) {
    throw new Error("Extension context invalidated");
  }
  const res = await fetch(chrome.runtime.getURL("src/sandbox/sandbox.html"));
  if (!res.ok) {
    throw new Error(`Failed to load sandbox html (${res.status})`);
  }
  sandboxHtmlCache = await res.text();
  return sandboxHtmlCache;
}

function frameEl(): HTMLIFrameElement | null {
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
}

function noteDeadFrame(reason: string): void {
  if (deadReported || !token) return;
  deadReported = true;
  stopPump();
  reportRuntimeError(reason, false);
}

function postToFrame(payload: Record<string, unknown>): void {
  const frame = frameEl();
  const win = frame?.contentWindow;
  if (!win) {
    noteDeadFrame("Sandbox frame disappeared");
    return;
  }
  try {
    win.postMessage({ source: HOST_SOURCE, token, ...payload }, "*");
  } catch {
    noteDeadFrame("Sandbox frame rejected messages");
  }
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

function rememberNodes(
  kind: string,
  selector: string,
  nodes: unknown[],
): void {
  if (kind !== "query" && kind !== "create" && kind !== "insert") return;
  const prev = JSON.stringify(queries[selector] ?? null);
  const next = JSON.stringify(nodes);
  queries[selector] = nodes;
  if (prev !== next) pumpState(true);
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
      if (
        result.kind === "query" ||
        result.kind === "create" ||
        result.kind === "insert"
      ) {
        rememberNodes(result.kind, result.selector, result.nodes);
      }
    } catch (err) {
      reportRuntimeError(
        err instanceof Error ? err.message : String(err),
        false,
      );
    }
    return;
  }

  if (data.type === "monacle-runtime-error") {
    const message =
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Scene runtime failed";
    reportRuntimeError(message, Boolean(data.fatal));
    if (data.fatal) stopPump();
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
  // Same-tab srcdoc — do NOT point src at the extension sandbox page.
  // chrome-extension:// sandbox pages spawn a Helper/ANGLE process and
  // Crashpad-dump the tab when a restyle arrives.
  frame.setAttribute("sandbox", "allow-scripts");
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

function waitReady(frame: HTMLIFrameElement): Promise<void> {
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
      resolve();
    }

    window.addEventListener("message", onReady);
  });
}

async function ensureMountedFrame(): Promise<HTMLIFrameElement> {
  const existing = frameEl();
  if (existing && frameIsUsable()) return existing;
  existing?.remove();

  ensureListener();
  const html = await loadSandboxHtml();
  const frame = createFrame();
  const ready = waitReady(frame);
  frame.srcdoc = html;
  await ready;
  return frame;
}

/** Mount the srcdoc runtime host before a restyle so apply does not spawn it. */
export function prewarmSandboxFrame(): void {
  if (!isExtensionContextValid()) return;
  mountChain = mountChain.then(
    async () => {
      try {
        return await ensureMountedFrame();
      } catch {
        return null;
      }
    },
    () => null,
  );
}

/** Stop pump + runtime without destroying the iframe (avoids ANGLE/GPU process thrash). */
function stopSandboxSession(): void {
  stopPump();
  handlers = null;
  queries = {};
  lastHostStateKey = "";
  lastHostStateAt = 0;
  deadReported = false;
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
  token = "";
}

/** Full teardown including iframe removal (reset / leave page). */
function teardownSandbox(): void {
  stopSandboxSession();
  frameEl()?.remove();
}

function frameIsUsable(): boolean {
  const frame = frameEl();
  // Sandboxed extension pages use an opaque origin — do not touch .location.
  // contentWindow is null when the renderer has died / frame is detached.
  if (!frame?.isConnected || !frame.contentWindow) return false;
  try {
    frame.contentWindow.postMessage({ source: HOST_SOURCE, type: "monacle-ping" }, "*");
    return true;
  } catch {
    return false;
  }
}

export function stopSandboxRuntime(): void {
  startGeneration += 1;
  // Keep the iframe across restyles — destroy/recreate thrash crashes Chrome.
  stopSandboxSession();
}

/** Full leave / RESET — remove the sandboxed iframe. */
export function destroySandboxRuntime(): void {
  startGeneration += 1;
  teardownSandbox();
}

async function startSandboxRuntimeInner(
  code: string,
  next: SandboxHostHandlers,
  generation: number,
): Promise<void> {
  if (generation !== startGeneration) return;
  if (!isExtensionContextValid()) {
    throw new Error("Extension context invalidated");
  }

  // Reuse the srcdoc frame. Never assign chrome-extension:// sandbox.html
  // as iframe.src — that Helper/ANGLE spawn Crashpad-dumps on apply.
  stopSandboxSession();
  if (generation !== startGeneration) return;

  if (!document.getElementById(OVERLAY_ID)) {
    throw new Error("Overlay host missing — cannot start sandboxed runtime");
  }

  await ensureMountedFrame();
  if (generation !== startGeneration) return;

  token = `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  handlers = next;
  queries = {};

  startPump();
  postToFrame({
    type: "monacle-runtime-start",
    code,
    ...hostStatePayload(),
  });
}

/**
 * Serialize starts so a newer start or stop cancels in-flight work.
 * No OffscreenCanvas transfer — DOM motion only. Reuses the sandbox iframe.
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
