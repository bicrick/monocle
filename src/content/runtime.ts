import { isProtectedElement, isRuntimeSourceAllowed } from "../patches/schema";
import {
  startSandboxRuntime,
  stopSandboxRuntime,
  type SerializedNode,
} from "./sandboxFrame";

const INSERT_MARK = "data-monacle-insert";
const RUNTIME_STYLE_ID = "monacle-runtime-css";
const OVERLAY_ID = "monacle-overlay";
const QUERY_CAP = 40;

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
  try {
    return Array.from(document.querySelectorAll(selector)).slice(0, QUERY_CAP);
  } catch {
    return [];
  }
}

export function getOverlayShadow(): ShadowRoot | null {
  const host = document.getElementById(OVERLAY_ID);
  if (!host) return null;
  return overlayShadows.get(host) ?? null;
}

export function rememberOverlayShadow(host: Element, shadow: ShadowRoot): void {
  overlayShadows.set(host, shadow);
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

function insertHtml(
  html: string,
  selector: string,
  position: "before" | "after" | "prepend" | "append" = "append",
): Element[] {
  const targets = safeQuery(selector);
  const created: Element[] = [];
  for (const target of targets) {
    if (isProtectedElement(target) && (position === "prepend" || position === "append")) {
      // Do not inject into protected media subtrees as children that could replace them.
      if (target.matches("video, audio")) continue;
    }
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const nodes = Array.from(template.content.childNodes);
    for (const node of nodes) {
      markInserted(node);
      if (node.nodeType === Node.ELEMENT_NODE) created.push(node as Element);
    }
    const frag = document.createDocumentFragment();
    for (const node of nodes) frag.appendChild(node);

    switch (position) {
      case "before":
        target.parentElement?.insertBefore(frag, target);
        break;
      case "after":
        target.parentElement?.insertBefore(frag, target.nextSibling);
        break;
      case "prepend":
        target.insertBefore(frag, target.firstChild);
        break;
      case "append":
        target.appendChild(frag);
        break;
    }
  }
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
      return insertHtml(html, opts.selector, opts.position ?? "append").map(
        wrapElementGuards,
      );
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
        canvas.width = Math.max(1, window.innerWidth || 1);
        canvas.height = Math.max(1, window.innerHeight || 1);
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
        fn(t);
      });
      rafIds.push(id);
      return id;
    },
    timeout(fn, ms) {
      const id = window.setTimeout(() => {
        timeoutIds = timeoutIds.filter((x) => x !== id);
        fn();
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
}

export function stopRuntime(): void {
  stopRuntimeEngine();
  document.querySelectorAll(`[${INSERT_MARK}]`).forEach((el) => el.remove());
  stopMediaCutoutTracking();
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
  rememberRuntime(code);
  const api = buildApi();
  const host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (host) startMediaCutoutTracking(host);

  void startSandboxRuntime(code, {
    query: (selector) => safeQuery(selector).map(serializeEl),
    insert: (html, opts) =>
      insertHtml(
        html,
        opts.selector,
        (opts.position as "before" | "after" | "prepend" | "append") ??
          "append",
      ).map(serializeEl),
    css: (text) => api.css(text),
    style: applyLiveStyle,
    media: collectMedia,
    viewport: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }),
    canvas: () => api.canvas(),
  }).catch((err) => {
    console.warn(
      "[Monacle] sandbox runtime failed to start",
      err instanceof Error ? err.message : err,
    );
  });
}

export { INSERT_MARK };
