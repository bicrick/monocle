import type {
  LandmarkNode,
  MediaInfo,
  PageContext,
  Rect,
} from "../shared/types";

const SENSITIVE_INPUT =
  /password|email|username|user|login|auth|token|ssn|card|cvv|otp/i;

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.top > window.innerHeight) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const parentEl: Element | null = cur.parentElement;
    if (parentEl) {
      const siblings = Array.from(parentEl.children).filter(
        (c: Element) => c.tagName === cur!.tagName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
    }
    parts.unshift(part);
    cur = parentEl;
  }
  return parts.join(" > ");
}

function textSnippet(el: Element, max = 80): string | undefined {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function shouldSkip(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") {
    return true;
  }
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = el as HTMLInputElement;
    if (input.type === "password") return true;
    const name = `${input.name} ${input.id} ${input.autocomplete}`;
    if (SENSITIVE_INPUT.test(name)) return true;
  }
  return false;
}

function landmarkFrom(el: Element, depth: number): LandmarkNode | null {
  if (depth > 4 || shouldSkip(el) || !visible(el)) return null;

  const role = el.getAttribute("role") ?? undefined;
  const interesting =
    depth === 0 ||
    !!el.id ||
    !!role ||
    /^(MAIN|NAV|HEADER|FOOTER|ASIDE|SECTION|ARTICLE|H1|H2|H3|VIDEO|YTD-)/i.test(
      el.tagName,
    );

  if (!interesting && depth > 1) return null;

  const node: LandmarkNode = {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.classList.length
      ? Array.from(el.classList).slice(0, 4)
      : undefined,
    role,
    text: textSnippet(el),
    rect: rectOf(el),
  };

  if (depth < 3) {
    const children: LandmarkNode[] = [];
    let count = 0;
    for (const child of Array.from(el.children)) {
      if (count >= 12) break;
      const childNode = landmarkFrom(child, depth + 1);
      if (childNode) {
        children.push(childNode);
        count++;
      }
    }
    if (children.length) node.children = children;
  }

  return node;
}

function collectMedia(): MediaInfo[] {
  const media: MediaInfo[] = [];
  const nodes = document.querySelectorAll("video, audio");
  nodes.forEach((el) => {
    if (!visible(el)) return;
    const tag = el.tagName.toLowerCase() as "video" | "audio";
    const info: MediaInfo = {
      tag,
      selector: cssPath(el),
      rect: rectOf(el),
    };
    if (el instanceof HTMLMediaElement) {
      info.paused = el.paused;
      info.currentTime = Math.round(el.currentTime);
      if (Number.isFinite(el.duration)) {
        info.duration = Math.round(el.duration);
      }
    }
    media.push(info);
  });
  return media.slice(0, 8);
}

/** Compact, sanitized snapshot — never includes cookies, storage, or secrets. */
export function captureSnapshot(): PageContext {
  const root =
    document.querySelector("ytd-app") ??
    document.querySelector("main") ??
    document.body;

  const landmarks: LandmarkNode[] = [];
  if (root) {
    const node = landmarkFrom(root, 0);
    if (node) landmarks.push(node);
  }

  // Always include a few high-signal YouTube landmarks when present
  for (const sel of [
    "#movie_player",
    "#secondary",
    "#comments",
    "ytd-masthead",
    "#chat",
  ]) {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) continue;
    landmarks.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: el.classList.length
        ? Array.from(el.classList).slice(0, 3)
        : undefined,
      text: textSnippet(el, 40),
      rect: rectOf(el),
    });
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    landmarks: landmarks.slice(0, 24),
    media: collectMedia(),
    capturedAt: Date.now(),
  };
}
