import {
  isProtectedElement,
  isRuntimeSourceAllowed,
  unsupportedRuntimeReason,
} from "../patches/schema";
import { capCanvasSize } from "../sandbox/safeCanvasDim";
import { isolateVoid } from "./isolate";
import {
  startSandboxRuntime,
  stopSandboxRuntime,
  destroySandboxRuntime,
  type SerializedNode,
} from "./sandboxFrame";
import {
  buildThreeApi,
  stopThreeStage,
  destroyThreeStage,
} from "./threeHost";
import { reportRuntimeError } from "./runtimeErrors";
export const INSERT_MARK = "data-monacle-insert";
const BATCH_MARK = "data-monacle-batch";
const SCENE_ID = "monacle-scene";
const RUNTIME_STYLE_ID = "monacle-runtime-css";
const OVERLAY_ID = "monacle-overlay";
const QUERY_CAP = 40;
/** Cap runtime-created nodes per create/insert call. */
const CREATE_CHILD_CAP = 80;
/** Same budget as applicator inserts — oversized HTML can OOM the tab. */
const MAX_CREATE_HTML = 200_000;

type CleanupFn = () => void;

interface MediaRect {
  tag: "video" | "audio";
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  paused?: boolean;
  currentTime?: number;
  duration?: number;
}

export interface MonacleHostApi {
  query(selector: string): Element[];
  insert(
    html: string,
    opts: {
      selector: string;
      position?: "before" | "after" | "prepend" | "append";
      batchId?: string;
    },
  ): Element[];
  create(
    html: string,
    opts?: {
      selector?: string;
      position?: "before" | "after" | "prepend" | "append";
      batchId?: string;
    },
  ): Element[];
  overlay: ShadowRoot | null;
  canvas(): HTMLCanvasElement;
  media(): MediaRect[];
  raf(fn: FrameRequestCallback): number;
  timeout(fn: () => void, ms: number): number;
  onCleanup(fn: CleanupFn): void;
  css(text: string): void;
}

const overlayShadows = new WeakMap<Element, ShadowRoot>();
let cleanups: CleanupFn[] = [];
let rafIds: number[] = [];
let timeoutIds: number[] = [];
let lastRuntime = "";
let maskObserver: ResizeObserver | null = null;
let maskRaf = 0;
let lastMaskKey = "";
let maskPollId = 0;

function safeQuery(selector: string): Element[] {
  const out: Element[] = [];
  try {
    out.push(...Array.from(document.querySelectorAll(selector)));
  } catch {
    // invalid selector
  }
  const shadow = getOverlayShadow();
  if (shadow) {
    try {
      out.push(...Array.from(shadow.querySelectorAll(selector)));
    } catch {
      // invalid selector in shadow
    }
  }
  return out.slice(0, QUERY_CAP);
}

export function getOverlayShadow(): ShadowRoot | null {
  const host = document.getElementById(OVERLAY_ID);
  if (!host) return null;
  return overlayShadows.get(host) ?? null;
}

export function rememberOverlayShadow(host: Element, shadow: ShadowRoot): void {
  overlayShadows.set(host, shadow);
}

/** Ensure overlay host + #monacle-scene exist for runtime-created nodes. */
export function ensureSceneRoot(): HTMLElement {
  let host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  let shadow = host ? getOverlayShadow() : null;
  if (!host || !shadow) {
    host = document.createElement("div");
    host.id = OVERLAY_ID;
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "0",
      pointerEvents: "none",
    });
    document.documentElement.insertBefore(
      host,
      document.documentElement.firstChild,
    );
    shadow = host.attachShadow({ mode: "closed" });
    (host as HTMLElement & { __monacleShadow?: ShadowRoot }).__monacleShadow =
      shadow;
    rememberOverlayShadow(host, shadow);
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .monacle-overlay-root {
        position: fixed; inset: 0; pointer-events: none; z-index: 0;
      }
      #monacle-scene {
        position: fixed; inset: 0; pointer-events: none; z-index: 1; overflow: hidden;
      }
    `;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "monacle-overlay-root";
    shadow.appendChild(root);
  }

  let scene = shadow.querySelector(`#${SCENE_ID}`) as HTMLElement | null;
  if (!scene) {
    scene = document.createElement("div");
    scene.id = SCENE_ID;
    scene.setAttribute("aria-hidden", "true");
    Object.assign(scene.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "1",
      overflow: "hidden",
    });
    shadow.appendChild(scene);
  }
  return scene;
}

function clearSceneRoot(): void {
  const shadow = getOverlayShadow();
  const scene = shadow?.querySelector(`#${SCENE_ID}`);
  if (scene) scene.replaceChildren();
}

function stampBatch(el: Element, batchId: string | undefined): void {
  if (batchId) el.setAttribute(BATCH_MARK, batchId);
}

function ensureRuntimeStyle(): HTMLStyleElement {
  let el = document.getElementById(RUNTIME_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = RUNTIME_STYLE_ID;
    document.documentElement.appendChild(el);
  }
  return el;
}

function markInserted(node: Node): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (!el.hasAttribute(INSERT_MARK)) {
      el.setAttribute(INSERT_MARK, "1");
    }
  }
}

function parseCreateNodes(
  html: string,
  batchId?: string,
): { frag: DocumentFragment; created: Element[] } {
  if (html.length > MAX_CREATE_HTML) {
    throw new Error(`create html exceeds ${MAX_CREATE_HTML} bytes`);
  }
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const created: Element[] = [];
  const frag = document.createDocumentFragment();
  for (const node of Array.from(template.content.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (created.length >= CREATE_CHILD_CAP) break;
      const el = node as Element;
      markInserted(el);
      stampBatch(el, batchId);
      created.push(el);
      frag.appendChild(node);
    } else {
      frag.appendChild(node);
    }
  }
  return { frag, created };
}

function insertHtml(
  html: string,
  selector: string,
  position: "before" | "after" | "prepend" | "append" = "append",
  batchId?: string,
): Element[] {
  const targets = safeQuery(selector);
  const created: Element[] = [];
  for (const target of targets) {
    isolateVoid(() => {
      if (
        isProtectedElement(target) &&
        (position === "prepend" || position === "append")
      ) {
        if (target.matches("video, audio")) return;
      }
      const parsed = parseCreateNodes(html, batchId);
      for (const el of parsed.created) created.push(el);
      switch (position) {
        case "before":
          target.parentElement?.insertBefore(parsed.frag, target);
          break;
        case "after":
          target.parentElement?.insertBefore(parsed.frag, target.nextSibling);
          break;
        case "prepend":
          target.insertBefore(parsed.frag, target.firstChild);
          break;
        case "append":
          target.appendChild(parsed.frag);
          break;
      }
    });
  }
  return created.slice(0, CREATE_CHILD_CAP);
}

/** Create Monacle-owned nodes in #monacle-scene, or page-level if selector given. */
function createHtml(
  html: string,
  opts?: {
    selector?: string;
    position?: "before" | "after" | "prepend" | "append";
    batchId?: string;
  },
): Element[] {
  const selector = opts?.selector?.trim();
  if (selector) {
    return insertHtml(
      html,
      selector,
      opts?.position ?? "append",
      opts?.batchId,
    );
  }
  const scene = ensureSceneRoot();
  const created: Element[] = [];
  isolateVoid(() => {
    const parsed = parseCreateNodes(html, opts?.batchId);
    for (const el of parsed.created) created.push(el);
    scene.appendChild(parsed.frag);
  });
  return created;
}

function collectMedia(): MediaRect[] {
  const out: MediaRect[] = [];
  const medias = document.querySelectorAll("video, audio");
  let i = 0;
  for (const el of medias) {
    if (i++ >= 20) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const tag = el.tagName === "AUDIO" ? "audio" : "video";
    let selector = tag;
    if (el.id) selector = `#${CSS.escape(el.id)}`;
    else if (el.classList.length) {
      selector = `${tag}.${Array.from(el.classList)
        .slice(0, 2)
        .map((c) => CSS.escape(c))
        .join(".")}`;
    }
    const mediaEl = el as HTMLMediaElement;
    out.push({
      tag,
      selector,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      paused: mediaEl.paused,
      currentTime: mediaEl.currentTime,
      duration: Number.isFinite(mediaEl.duration) ? mediaEl.duration : undefined,
    });
  }
  return out;
}

/** CSS mask that punches holes for live media so overlays do not cover video. */
export function applyMediaCutoutMask(host: HTMLElement): void {
  const medias = collectMedia();
  if (!medias.length) {
    if (lastMaskKey !== "") {
      host.style.webkitMaskImage = "";
      host.style.maskImage = "";
      lastMaskKey = "";
    }
    return;
  }
  const holes = medias
    .map((m) => {
      const { x, y, width, height } = m.rect;
      return `linear-gradient(#000 0 0) ${x}px ${y}px / ${width}px ${height}px no-repeat`;
    })
    .join(", ");
  if (holes === lastMaskKey) return;
  lastMaskKey = holes;
  // Full cover then punch transparent holes via mask-composite
  const mask = `linear-gradient(#000 0 0), ${holes}`;
  host.style.maskImage = mask;
  host.style.webkitMaskImage = mask;
  host.style.maskSize = "100% 100%, auto";
  (host.style as CSSStyleDeclaration & { webkitMaskSize?: string }).webkitMaskSize =
    "100% 100%, auto";
  host.style.maskRepeat = "no-repeat";
  (host.style as CSSStyleDeclaration & { webkitMaskRepeat?: string }).webkitMaskRepeat =
    "no-repeat";
  host.style.maskComposite = "exclude";
  (
    host.style as CSSStyleDeclaration & { webkitMaskComposite?: string }
  ).webkitMaskComposite = "xor";
}

function scheduleCutout(host: HTMLElement): void {
  if (maskRaf) return;
  maskRaf = requestAnimationFrame(() => {
    maskRaf = 0;
    applyMediaCutoutMask(host);
  });
}

export function startMediaCutoutTracking(host: HTMLElement): void {
  stopMediaCutoutTracking();
  applyMediaCutoutMask(host);
  // Coalesce resize/rect changes — do not rewrite mask styles every display frame.
  maskObserver = new ResizeObserver(() => scheduleCutout(host));
  maskObserver.observe(document.documentElement);
  for (const el of document.querySelectorAll("video, audio")) {
    maskObserver.observe(el);
  }
  // Occasional poll for media that moves without resizing (player layout shifts).
  maskPollId = window.setInterval(() => scheduleCutout(host), 250);
}

export function stopMediaCutoutTracking(): void {
  if (maskRaf) {
    cancelAnimationFrame(maskRaf);
    maskRaf = 0;
  }
  if (maskPollId) {
    clearInterval(maskPollId);
    maskPollId = 0;
  }
  maskObserver?.disconnect();
  maskObserver = null;
  lastMaskKey = "";
}

function guardProtectedMutation(el: Element, action: string): boolean {
  if (!isProtectedElement(el) && !el.matches("video, audio")) return true;
  console.warn(`[Monacle] blocked ${action} on protected media element`);
  return false;
}

function wrapElementGuards(el: Element): Element {
  if (!(el instanceof HTMLElement) && !(el instanceof Element)) return el;
  const proxy = new Proxy(el, {
    get(target, prop, receiver) {
      if (prop === "remove") {
        return () => {
          if (!guardProtectedMutation(target, "remove")) return;
          if (target.hasAttribute(INSERT_MARK)) target.remove();
        };
      }
      if (prop === "replaceWith") {
        return (...args: Node[]) => {
          if (!guardProtectedMutation(target, "replaceWith")) return;
          Reflect.apply(target.replaceWith, target, args);
        };
      }
      if (prop === "src") {
        return (target as HTMLMediaElement).src;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
    set(target, prop, value, receiver) {
      if (prop === "src" && (target.matches("video, audio") || isProtectedElement(target))) {
        console.warn("[Monacle] blocked src write on media");
        return true;
      }
      if (
        prop === "innerHTML" &&
        (target.matches("video, audio") || isProtectedElement(target))
      ) {
        console.warn("[Monacle] blocked innerHTML on protected element");
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });
  return proxy;
}

function buildApi(): MonacleHostApi {
  return {
    query(selector: string) {
      return safeQuery(selector).map(wrapElementGuards);
    },
    insert(html, opts) {
      return insertHtml(
        html,
        opts.selector,
        opts.position ?? "append",
        opts.batchId,
      ).map(wrapElementGuards);
    },
    create(html, opts) {
      return createHtml(html, opts).map(wrapElementGuards);
    },
    get overlay() {
      return getOverlayShadow();
    },
    canvas() {
      const shadow = getOverlayShadow();
      if (!shadow) {
        throw new Error("Overlay not ready — set overlayHtml or apply a scene first");
      }
      let canvas = shadow.querySelector(
        "canvas[data-monacle-canvas]",
      ) as HTMLCanvasElement | null;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.setAttribute("data-monacle-canvas", "1");
        const size = capCanvasSize(
          window.innerWidth || 1,
          window.innerHeight || 1,
        );
        canvas.width = size.width;
        canvas.height = size.height;
        Object.assign(canvas.style, {
          position: "fixed",
          inset: "0",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: "0",
        });
        const root =
          shadow.querySelector(".monacle-overlay-root") || shadow;
        root.appendChild(canvas);
      }
      return canvas;
    },
    media: collectMedia,
    raf(fn) {
      const id = requestAnimationFrame((t) => {
        rafIds = rafIds.filter((x) => x !== id);
        try {
          fn(t);
        } catch (err) {
          reportRuntimeError(
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      rafIds.push(id);
      return id;
    },
    timeout(fn, ms) {
      const id = window.setTimeout(() => {
        timeoutIds = timeoutIds.filter((x) => x !== id);
        try {
          fn();
        } catch (err) {
          reportRuntimeError(
            err instanceof Error ? err.message : String(err),
          );
        }
      }, ms);
      timeoutIds.push(id);
      return id;
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
    css(text) {
      ensureRuntimeStyle().textContent = text;
    },
  };
}

function serializeEl(el: Element): SerializedNode {
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    className: typeof el.className === "string" ? el.className : "",
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

function applyLiveStyle(
  selector: string,
  index: number,
  props: Record<string, string>,
): void {
  const els = safeQuery(selector);
  const el = els[index];
  if (!(el instanceof HTMLElement)) return;
  if (isProtectedElement(el) && el.matches("video, audio")) return;
  for (const [prop, value] of Object.entries(props)) {
    if (typeof value !== "string") continue;
    const cssProp = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    try {
      el.style.setProperty(cssProp, value);
    } catch {
      // ignore invalid style props
    }
  }
}

function stopRuntimeEngine(): void {
  stopSandboxRuntime();
  stopThreeStage();
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
  for (const id of rafIds.splice(0)) cancelAnimationFrame(id);
  for (const id of timeoutIds.splice(0)) clearTimeout(id);
  document.getElementById(RUNTIME_STYLE_ID)?.remove();
  const shadow = getOverlayShadow();
  shadow?.querySelector("canvas[data-monacle-canvas]")?.remove();
  clearSceneRoot();
}

export function stopRuntime(): void {
  stopRuntimeEngine();
  document.querySelectorAll(`[${INSERT_MARK}]`).forEach((el) => el.remove());
  // Scene lives in closed shadow — clearSceneRoot already emptied it; also drop
  // any leftover batch-marked nodes inside the shadow.
  const shadow = getOverlayShadow();
  shadow
    ?.querySelectorAll(`[${INSERT_MARK}]`)
    .forEach((el) => el.remove());
  stopMediaCutoutTracking();
}

/** Full leave / RESET — destroy sandbox iframe + three inject state. */
export function destroyRuntime(): void {
  stopRuntime();
  destroySandboxRuntime();
  destroyThreeStage();
}

export function rememberRuntime(code: string): void {
  lastRuntime = code;
}

export function getLastRuntime(): string {
  return lastRuntime;
}

export function clearRuntimeMemory(): void {
  lastRuntime = "";
}

export function runRuntime(code: string): void {
  stopRuntimeEngine();
  if (!code.trim()) return;
  if (!isRuntimeSourceAllowed(code)) {
    throw new Error("Runtime rejected: chrome/browser APIs are not allowed");
  }
  const unsupported = unsupportedRuntimeReason(code);
  if (unsupported) {
    rememberRuntime(code);
    reportRuntimeError(unsupported, true);
    throw new Error(unsupported);
  }
  rememberRuntime(code);
  const api = buildApi();
  ensureSceneRoot();
  const host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (host) startMediaCutoutTracking(host);

  // Defer so CSS/ops commit first. A sandbox mount failure must not
  // unwind the static scene or trip a fatal repair loop.
  window.setTimeout(() => {
    void startSandboxRuntime(code, {
      query: (selector) => safeQuery(selector).map(serializeEl),
      insert: (html, opts) =>
        insertHtml(
          html,
          opts.selector,
          (opts.position as "before" | "after" | "prepend" | "append") ??
            "append",
          opts.batchId,
        ).map(serializeEl),
      create: (html, opts) =>
        createHtml(html, {
          selector: opts?.selector,
          position: opts?.position as
            | "before"
            | "after"
            | "prepend"
            | "append"
            | undefined,
          batchId: opts?.batchId,
        }).map(serializeEl),
      css: (text) => api.css(text),
      style: applyLiveStyle,
      three: buildThreeApi(),
      media: collectMedia,
      viewport: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    }).catch((err) => {
      reportRuntimeError(
        err instanceof Error ? err.message : String(err),
        false,
      );
    });
  }, 0);
}
