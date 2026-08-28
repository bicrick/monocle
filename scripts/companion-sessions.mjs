/**
 * Concurrent agent-run registry for the local companion.
 * Manual sidepanel and autonomous loops each get an isolated session.
 */
import { recentLines } from "./companion-log.mjs";

const MAX_LINES = 40;
const MAX_RETAINED_ENDED = 24;
const DEFAULT_MAX_CONCURRENT = 8;

let maxConcurrentLimit = Number(
  process.env.MONACLE_MAX_CONCURRENT || DEFAULT_MAX_CONCURRENT,
);
if (!Number.isFinite(maxConcurrentLimit) || maxConcurrentLimit < 1) {
  maxConcurrentLimit = DEFAULT_MAX_CONCURRENT;
}

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {boolean} running
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {string | null} model
 * @property {string} source
 * @property {string} promptPreview
 * @property {string[]} lines
 * @property {string} thinking
 * @property {string} payload
 */

export class SessionError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}

export function maxConcurrent() {
  return maxConcurrentLimit;
}

export function activeCount() {
  let n = 0;
  for (const session of sessions.values()) {
    if (session.running) n += 1;
  }
  return n;
}

export function configure({ maxConcurrent: next } = {}) {
  if (next != null) {
    const n = Number(next);
    if (Number.isFinite(n) && n >= 1) maxConcurrentLimit = n;
  }
}

export function resetForTests() {
  sessions.clear();
  maxConcurrentLimit = DEFAULT_MAX_CONCURRENT;
}

function newId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeId(id) {
  if (id == null) return null;
  const cleaned = String(id)
    .trim()
    .replace(/[^\w.+-]/g, "_")
    .slice(0, 80);
  return cleaned || null;
}

function prune() {
  const ended = [...sessions.values()]
    .filter((s) => !s.running)
    .sort((a, b) => b.endedAt - a.endedAt);
  for (const extra of ended.slice(MAX_RETAINED_ENDED)) {
    sessions.delete(extra.id);
  }
}

function pushLine(session, line) {
  if (!line) return;
  if (session.lines[session.lines.length - 1] === line) return;
  session.lines.push(line);
  if (session.lines.length > MAX_LINES) session.lines.shift();
}

export function createSession({
  id,
  model,
  source,
  prompt,
} = {}) {
  const active = activeCount();
  if (active >= maxConcurrentLimit) {
    throw new SessionError(
      `Companion at capacity (${maxConcurrentLimit} concurrent agents)`,
      "BUSY",
      429,
    );
  }

  const sid = normalizeId(id) || newId();
  const existing = sessions.get(sid);
  if (existing?.running) {
    throw new SessionError(
      `Session ${sid} is already running`,
      "SESSION_BUSY",
      409,
    );
  }

  const session = {
    id: sid,
    running: true,
    startedAt: Date.now(),
    endedAt: 0,
    model: model || null,
    source: String(source || "restyle").slice(0, 32),
    promptPreview: String(prompt || "").slice(0, 80),
    lines: [],
    thinking: "",
    payload: "",
  };
  sessions.set(sid, session);
  prune();
  return session;
}

export function getSession(id) {
  return sessions.get(normalizeId(id) || "") || null;
}

export function endSession(id) {
  const session = getSession(id);
  if (!session) return null;
  session.running = false;
  session.endedAt = Date.now();
  session.thinking = "";
  prune();
  return session;
}

export function beginRun({ sessionId, model, source, prompt } = {}) {
  const session = createSession({
    id: sessionId,
    model,
    source,
    prompt,
  });
  pushLine(session, session.model ? `Asking ${session.model}…` : "Thinking…");
  return session;
}

export function endRun(sessionId) {
  return endSession(sessionId);
}

export function ingestStep(sessionId, line) {
  const session = getSession(sessionId);
  if (!session) return;
  const text = String(line || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!text) return;
  pushLine(session, text.slice(0, 200));
}

export function ingestThinking(sessionId, full) {
  const session = getSession(sessionId);
  if (!session) return;
  session.thinking = String(full || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function ingestPayload(sessionId, text) {
  const session = getSession(sessionId);
  if (!session) return;
  const next = String(text || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!next) return;
  session.payload = next.slice(0, 24_000);
}

/** @deprecated Prefer ingestStep — kept for stderr noise. */
export function ingestChunk(sessionId, chunk) {
  const session = getSession(sessionId);
  if (!session) return;
  const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  for (const part of text.split(/\r?\n/)) {
    const line = part.trim();
    if (!line || line.startsWith("{")) continue;
    if (line.length > 200) {
      pushLine(session, `${line.slice(0, 140)}…`);
    } else {
      pushLine(session, line.slice(0, 160));
    }
  }
}

function editLabelForPayload(payload) {
  const t = String(payload || "");
  if (
    /"runtime"\s*:/.test(t) &&
    !/"css"\s*:/.test(t) &&
    !/"overlayHtml"\s*:/.test(t)
  ) {
    return "Editing scene";
  }
  return "Writing restyle";
}

function formatSnapshot(session) {
  const elapsedMs = session.startedAt ? Date.now() - session.startedAt : 0;
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  const steps = session.lines.slice();
  if (session.running && session.thinking) {
    steps.push(`Thinking: ${session.thinking}`);
  }
  if (
    session.payload &&
    !steps.some((s) => /^(Writing restyle|Editing scene)/i.test(s))
  ) {
    steps.push(editLabelForPayload(session.payload));
  }
  return {
    sessionId: session.id,
    source: session.source,
    running: session.running,
    model: session.model,
    elapsedMs,
    promptPreview: session.promptPreview,
    thinking: session.running ? session.thinking : "",
    hasPayload: Boolean(session.payload),
    payload: session.payload || "",
    lines: steps,
    raw: recentLines(40),
    summary: session.running
      ? session.thinking
        ? `Thinking… ${secs}s`
        : `Working… ${secs}s`
      : session.lines[session.lines.length - 1] || "",
  };
}

function emptySnapshot() {
  return {
    sessionId: null,
    source: null,
    running: false,
    model: null,
    elapsedMs: 0,
    promptPreview: "",
    thinking: "",
    hasPayload: false,
    payload: "",
    lines: [],
    raw: recentLines(40),
    summary: "",
    count: 0,
    sessions: [],
  };
}

export function summarize(session) {
  return {
    id: session.id,
    source: session.source,
    running: session.running,
    model: session.model,
    elapsedMs: session.startedAt ? Date.now() - session.startedAt : 0,
    promptPreview: session.promptPreview,
    lastLine: session.lines[session.lines.length - 1] || "",
  };
}

export function listSnapshots() {
  return [...sessions.values()].map(summarize);
}

export function aggregateSnapshot() {
  const all = [...sessions.values()];
  const running = all.filter((s) => s.running);
  const primary = running[running.length - 1] || all[all.length - 1];
  const listed = all.map(summarize);
  if (!primary) {
    return { ...emptySnapshot(), sessions: listed };
  }
  const base = formatSnapshot(primary);
  if (running.length <= 1) {
    return { ...base, count: running.length, sessions: listed };
  }
  const lines = [];
  for (const session of running) {
    const tag = session.source || session.id;
    for (const line of session.lines.slice(-12)) {
      lines.push(`[${tag}] ${line}`);
    }
    if (session.thinking) {
      lines.push(`[${tag}] Thinking: ${session.thinking}`);
    }
    if (session.payload) {
      lines.push(`[${tag}] ${editLabelForPayload(session.payload)}`);
    }
  }
  return {
    ...base,
    running: true,
    count: running.length,
    lines,
    thinking: primary.running ? primary.thinking : "",
    hasPayload: running.some((s) => Boolean(s.payload)),
    payload: "",
    summary: `${running.length} agents running`,
    sessions: listed,
  };
}

export function snapshot(sessionId) {
  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      return { ...emptySnapshot(), sessionId: normalizeId(sessionId) };
    }
    return {
      ...formatSnapshot(session),
      count: session.running ? 1 : 0,
      sessions: [summarize(session)],
    };
  }
  return aggregateSnapshot();
}
