/** Readable page extract for agent tab tools (not the compact restyle snapshot). */

export interface PageLink {
  href: string;
  text: string;
}

export interface PageRead {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
  capturedAt: number;
}

const MAX_TEXT = 40_000;
const MAX_LINKS = 80;

function sameOrigin(href: string, origin: string): boolean {
  try {
    return new URL(href, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function pickRoot(): Element {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body
  );
}

/** Full-page readable text + same-origin links (scroll position does not truncate). */
export function capturePageRead(): PageRead {
  const root = pickRoot();
  const textSource =
    (root instanceof HTMLElement ? root.innerText : "") ||
    document.body?.innerText ||
    "";
  let text = cleanText(textSource);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n…[truncated]`;
  }

  const origin = location.origin;
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= MAX_LINKS) break;
    const el = a as HTMLAnchorElement;
    const href = el.href;
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;
    if (!sameOrigin(href, origin)) continue;
    let normalized = href;
    try {
      const u = new URL(href);
      u.hash = "";
      normalized = u.toString();
    } catch {
      // keep raw
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const label = cleanText(el.textContent || el.getAttribute("aria-label") || "");
    links.push({
      href: normalized,
      text: label.slice(0, 120),
    });
  }

  return {
    url: location.href,
    title: document.title,
    text,
    links,
    capturedAt: Date.now(),
  };
}
