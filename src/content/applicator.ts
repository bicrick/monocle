import type { Patch, PatchOp } from "../shared/types";
import { isProtectedElement } from "../patches/schema";
import {
  INSERT_MARK,
  clearRuntimeMemory,
  getLastRuntime,
  rememberOverlayShadow,
  rememberRuntime,
  runRuntime,
  startMediaCutoutTracking,
  stopRuntime,
} from "./runtime";

const STYLE_ID = "monacle-css";
const OVERLAY_ID = "monacle-overlay";
const MARK = "data-monacle-op";

function ensureStyle(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.documentElement.appendChild(el);
  }
  return el;
}

function getOrCreateOverlayHost(): { host: HTMLElement; shadow: ShadowRoot } {
  let host = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (host) {
    const existing = (host as HTMLElement & { __monacleShadow?: ShadowRoot })
      .__monacleShadow;
    if (existing) {
      rememberOverlayShadow(host, existing);
      return { host, shadow: existing };
    }
    host.remove();
  }

  host = document.createElement("div");
  host.id = OVERLAY_ID;
  // Scene sits behind page media; pointer-events none so the player stays usable.
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "0",
    pointerEvents: "none",
  });
  // Insert as first child so page chrome/media can paint above when they have stacking.
  document.documentElement.insertBefore(host, document.documentElement.firstChild);
  const shadow = host.attachShadow({ mode: "closed" });
  (host as HTMLElement & { __monacleShadow?: ShadowRoot }).__monacleShadow =
    shadow;
  rememberOverlayShadow(host, shadow);
  return { host, shadow };
}

function raiseProtectedMedia(): void {
  document.querySelectorAll("video, audio").forEach((el) => {
    const player =
      el.closest(
        "#movie_player, #player, #player-container, ytd-player, .html5-video-player",
      ) || el.parentElement;
    if (player instanceof HTMLElement) {
      const cs = getComputedStyle(player);
      if (cs.position === "static") {
        player.style.setProperty("position", "relative");
      }
      player.style.setProperty("z-index", "2");
    }
    if (el instanceof HTMLElement) {
      const cs = getComputedStyle(el);
      if (cs.position === "static") {
        el.style.setProperty("position", "relative");
      }
      el.style.setProperty("z-index", "2");
    }
  });
}

function applyOverlay(html: string): void {
  const { host, shadow } = getOrCreateOverlayHost();
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .monacle-overlay-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: system-ui, -apple-system, sans-serif;
        z-index: 0;
      }
    </style>
    <div class="monacle-overlay-root">${html}</div>
  `;
  raiseProtectedMedia();
  startMediaCutoutTracking(host);
}

function safeQuery(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector)).slice(0, 40);
  } catch {
    return [];
  }
}

function applyInsert(op: PatchOp): void {
  if (!op.html) return;
  const position = op.position || "append";
  const els = safeQuery(op.selector);
  for (const el of els) {
    if (el.matches("video, audio") && (position === "prepend" || position === "append")) {
      continue;
    }
    const template = document.createElement("template");
    template.innerHTML = op.html.trim();
    const frag = document.createDocumentFragment();
    for (const node of Array.from(template.content.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (!el.hasAttribute(INSERT_MARK)) {
          el.setAttribute(INSERT_MARK, "1");
        }
      }
      frag.appendChild(node);
    }
    switch (position) {
      case "before":
        el.parentElement?.insertBefore(frag, el);
        break;
      case "after":
        el.parentElement?.insertBefore(frag, el.nextSibling);
        break;
      case "prepend":
        el.insertBefore(frag, el.firstChild);
        break;
      case "append":
        el.appendChild(frag);
        break;
    }
  }
}

function applyRemove(op: PatchOp): void {
  const els = safeQuery(op.selector);
  for (const el of els) {
    if (!el.hasAttribute(INSERT_MARK)) continue;
    if (isProtectedElement(el) || el.matches("video, audio")) continue;
    el.remove();
  }
}

function applyOp(op: PatchOp): void {
  if (op.type === "insert") {
    applyInsert(op);
    return;
  }
  if (op.type === "remove") {
    applyRemove(op);
    return;
  }

  const els = safeQuery(op.selector);
  for (const el of els) {
    if (isProtectedElement(el) && (op.type === "wrap" || op.type === "move")) {
      if (el.matches("video, audio")) continue;
    }
    if (el.matches("video, audio") && op.type !== "restyle" && op.type !== "show") {
      continue;
    }

    switch (op.type) {
      case "hide":
        (el as HTMLElement).style.setProperty("display", "none", "important");
        el.setAttribute(MARK, "hide");
        break;
      case "show":
        (el as HTMLElement).style.removeProperty("display");
        el.removeAttribute(MARK);
        break;
      case "restyle":
        if (op.css) {
          for (const [prop, value] of Object.entries(op.css)) {
            (el as HTMLElement).style.setProperty(
              prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
              value,
            );
          }
          el.setAttribute(MARK, "restyle");
        }
        break;
      case "wrap": {
        if (el.parentElement?.hasAttribute(MARK)) break;
        if (isProtectedElement(el) && el.querySelector("video, audio")) {
          if (el.matches("video, audio")) break;
        }
        const wrapper = document.createElement(op.wrapTag || "div");
        if (op.wrapClass) wrapper.className = op.wrapClass;
        wrapper.setAttribute(MARK, "wrap");
        el.parentElement?.insertBefore(wrapper, el);
        wrapper.appendChild(el);
        break;
      }
      case "move": {
        if (!op.targetSelector) break;
        const target = document.querySelector(op.targetSelector);
        if (!target) break;
        if (el.matches("video, audio")) break;
        target.appendChild(el);
        el.setAttribute(MARK, "move");
        break;
      }
    }
  }
}

export function applyPatch(patch: Patch): void {
  // Tear down prior runtime before mutating so cleanup sees prior inserts.
  stopRuntime();

  if (patch.css) {
    ensureStyle().textContent = patch.css;
  }
  if (typeof patch.overlayHtml === "string") {
    applyOverlay(patch.overlayHtml);
  } else if (patch.runtime) {
    // Ensure overlay host exists for canvas/scene even without static HTML.
    const { host } = getOrCreateOverlayHost();
    raiseProtectedMedia();
    startMediaCutoutTracking(host);
  }
  if (patch.ops) {
    for (const op of patch.ops) applyOp(op);
  }
  if (typeof patch.runtime === "string" && patch.runtime.trim()) {
    runRuntime(patch.runtime);
  } else {
    clearRuntimeMemory();
  }
  document.documentElement.setAttribute("data-monacle", "on");
}

export function resetPatch(): void {
  stopRuntime();
  clearRuntimeMemory();
  lastCss = "";
  lastOverlay = "";
  lastOps = [];
  lastRuntimeCode = "";

  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(OVERLAY_ID)?.remove();
  document.querySelectorAll(`[${INSERT_MARK}]`).forEach((el) => el.remove());

  document.querySelectorAll(`[${MARK}]`).forEach((el) => {
    const kind = el.getAttribute(MARK);
    if (kind === "hide") {
      (el as HTMLElement).style.removeProperty("display");
    }
    if (kind === "wrap") {
      const parent = el.parentElement;
      while (el.firstChild) parent?.insertBefore(el.firstChild, el);
      el.remove();
      return;
    }
    el.removeAttribute(MARK);
  });

  document.documentElement.removeAttribute("data-monacle");
}

export function hasActivePatch(): boolean {
  return (
    document.documentElement.getAttribute("data-monacle") === "on" ||
    !!document.getElementById(STYLE_ID) ||
    !!document.getElementById(OVERLAY_ID) ||
    !!getLastRuntime()
  );
}

/** Re-apply last scene after SPA churn. */
let lastCss = "";
let lastOverlay = "";
let lastOps: PatchOp[] = [];
let lastRuntimeCode = "";

export function rememberPatch(patch: Patch): void {
  if (patch.css) lastCss = patch.css;
  if (typeof patch.overlayHtml === "string") lastOverlay = patch.overlayHtml;
  if (patch.ops) lastOps = patch.ops;
  if (typeof patch.runtime === "string" && patch.runtime.trim()) {
    lastRuntimeCode = patch.runtime;
    rememberRuntime(patch.runtime);
  } else {
    lastRuntimeCode = "";
    clearRuntimeMemory();
  }
}

export function reassertPatch(): void {
  if (
    !hasActivePatch() &&
    !lastCss &&
    !lastOverlay &&
    !lastOps.length &&
    !lastRuntimeCode
  ) {
    return;
  }
  stopRuntime();
  if (lastCss) ensureStyle().textContent = lastCss;
  if (lastOverlay) applyOverlay(lastOverlay);
  else if (lastRuntimeCode) {
    const { host } = getOrCreateOverlayHost();
    raiseProtectedMedia();
    startMediaCutoutTracking(host);
  }
  for (const op of lastOps) applyOp(op);
  if (lastRuntimeCode) runRuntime(lastRuntimeCode);
  document.documentElement.setAttribute("data-monacle", "on");
}

export function clearMemory(): void {
  lastCss = "";
  lastOverlay = "";
  lastOps = [];
  lastRuntimeCode = "";
  clearRuntimeMemory();
}
