import type { SessionSummary } from "../shared/types";

/** Titles that are blank shells or look like stored junk / URLs. */
export function isBlankTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  return !t || /^new chat$/i.test(t) || /^untitled( chat)?$/i.test(t);
}

export function isJunkTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (/^(chrome|moz|safari)-extension:/i.test(t)) return true;
  if (/^(data|blob):/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  const readable = t.replace(/[^\p{L}\p{N}\s]+/gu, " ").trim();
  if (readable.length < 2) return true;
  return false;
}

export function displaySessionTitle(s: SessionSummary): string {
  const raw = (s.title || "").replace(/\s+/g, " ").trim();
  if (raw && !isBlankTitle(raw) && !isJunkTitle(raw)) return raw;

  const page = (s.pageTitle || "").replace(/\s+/g, " ").trim();
  if (page && !isJunkTitle(page)) return page;

  if (s.host) return s.host;
  return "Untitled chat";
}

export function isEmptyShell(s: SessionSummary): boolean {
  return isBlankTitle(s.title || "");
}

/** Hide unused "New chat" shells; keep active and any real turns. */
export function visibleSessions(
  sessions: SessionSummary[],
  activeId: string | null,
): SessionSummary[] {
  const kept = sessions.filter((s) => s.id === activeId || !isEmptyShell(s));
  if (kept.length) return kept;
  if (activeId) {
    const active = sessions.find((s) => s.id === activeId);
    if (active) return [active];
  }
  return sessions.slice(0, 1);
}

export function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/** http(s) page the conversation was about — not chrome/about/data. */
export function isOpenableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
