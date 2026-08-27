import type {
  ActivityLine,
  ChatMessage,
  ChatSession,
  SessionSummary,
} from "../shared/types";

const STORAGE_KEY = "chatSessions";
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 40;
const MAX_HISTORY = 20;
const MAX_ACTIVITY = 24;

function newId(): string {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Strip hash so the same page resumes; keep query (YouTube video ids). */
export function urlKeyFrom(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url.split("#")[0] || url;
  }
}

function hostFrom(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function titleFromPrompt(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  // Don't persist URLs / extension schemes as the chat title.
  if (/^(chrome|moz|safari)-extension:/i.test(t) || /^(https?:|data:|blob:)/i.test(t)) {
    return "New chat";
  }
  if (t.length <= 48) return t;
  return `${t.slice(0, 45)}…`;
}

async function readAll(): Promise<ChatSession[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  return Array.isArray(raw) ? (raw as ChatSession[]) : [];
}

async function writeAll(sessions: ChatSession[]): Promise<void> {
  const trimmed = sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
  await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
}

export function toSummary(s: ChatSession): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    pageTitle: s.pageTitle,
    url: s.url,
    urlKey: s.urlKey,
    updatedAt: s.updatedAt,
    host: hostFrom(s.url),
  };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const all = await readAll();
  return all
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSummary);
}

export async function getSession(id: string): Promise<ChatSession | null> {
  const all = await readAll();
  return all.find((s) => s.id === id) ?? null;
}

export async function findLatestForUrl(
  url: string,
): Promise<ChatSession | null> {
  const key = urlKeyFrom(url);
  const all = await readAll();
  const matches = all
    .filter((s) => s.urlKey === key)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] ?? null;
}

export async function createSession(opts: {
  url: string;
  pageTitle: string;
  title?: string;
}): Promise<ChatSession> {
  const now = Date.now();
  const session: ChatSession = {
    id: newId(),
    title: opts.title?.trim() || "New chat",
    pageTitle: opts.pageTitle || "",
    url: opts.url,
    urlKey: urlKeyFrom(opts.url),
    createdAt: now,
    updatedAt: now,
    messages: [],
    history: [],
    activity: [],
  };
  const all = await readAll();
  all.unshift(session);
  await writeAll(all);
  return session;
}

export async function saveSession(session: ChatSession): Promise<void> {
  session.updatedAt = Date.now();
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  if (session.activity.length > MAX_ACTIVITY) {
    session.activity = session.activity.slice(-MAX_ACTIVITY);
  }
  const all = await readAll();
  const idx = all.findIndex((s) => s.id === session.id);
  if (idx >= 0) all[idx] = session;
  else all.unshift(session);
  await writeAll(all);
}

export async function appendMessage(
  sessionId: string,
  msg: ChatMessage,
): Promise<ChatSession | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.messages.push(msg);
  if (
    msg.role === "user" &&
    (session.title === "New chat" || !session.title.trim())
  ) {
    session.title = titleFromPrompt(msg.content);
  }
  await saveSession(session);
  return session;
}

export async function setActivity(
  sessionId: string,
  activity: ActivityLine[],
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  session.activity = activity.slice(-MAX_ACTIVITY);
  await saveSession(session);
}

export async function touchPageMeta(
  sessionId: string,
  url: string,
  pageTitle: string,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  session.url = url;
  session.urlKey = urlKeyFrom(url);
  session.pageTitle = pageTitle;
  await saveSession(session);
}
