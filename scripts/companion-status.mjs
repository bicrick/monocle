/** Short status snapshot for the sidepanel poller. Full text lives in companion-log. */
import { recentLines } from "./companion-log.mjs";

const MAX_LINES = 24;

const state = {
  running: false,
  startedAt: 0,
  model: null,
  lines: [],
};

function pushLine(line) {
  if (!line) return;
  if (state.lines[state.lines.length - 1] === line) return;
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.shift();
}

function abstractLine(raw) {
  const line = String(raw)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!line) return null;
  if (/^```/.test(line)) return null;
  if (line.startsWith("{") && line.length > 80) return null;
  if (line.length > 200) {
    const tool = line.match(
      /\b(Read|Edit|Grep|Glob|Shell|Write|Task|Apply|Search)\b/,
    );
    if (tool) return tool[1];
    return `${line.slice(0, 140)}…`;
  }
  return line.slice(0, 160);
}

export function beginRun(model) {
  state.running = true;
  state.startedAt = Date.now();
  state.model = model || null;
  state.lines = [];
  pushLine(model ? `model ${model}` : "Cursor CLI started");
}

export function endRun() {
  state.running = false;
}

export function ingestChunk(chunk) {
  const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  for (const part of text.split(/\r?\n/)) {
    const line = abstractLine(part);
    if (line) pushLine(line);
  }
}

export function snapshot() {
  const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  return {
    running: state.running,
    model: state.model,
    elapsedMs,
    lines: state.lines.slice(),
    raw: recentLines(80),
    summary: state.running
      ? `waiting… ${secs}s`
      : state.lines[state.lines.length - 1] || "",
  };
}
