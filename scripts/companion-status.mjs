/** Agent-step snapshot for the sidepanel — thinking / tools, not spawn plumbing. */
import { recentLines } from "./companion-log.mjs";

const MAX_LINES = 40;

const state = {
  running: false,
  startedAt: 0,
  model: null,
  lines: [],
  thinking: "",
};

function pushLine(line) {
  if (!line) return;
  if (state.lines[state.lines.length - 1] === line) return;
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.shift();
}

export function beginRun(model) {
  state.running = true;
  state.startedAt = Date.now();
  state.model = model || null;
  state.lines = [];
  state.thinking = "";
  pushLine(model ? `Asking ${model}…` : "Thinking…");
}

export function endRun() {
  state.running = false;
}

/** Human step from stream-json (tool / thinking summary / done). */
export function ingestStep(line) {
  const text = String(line || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!text) return;
  pushLine(text.slice(0, 200));
}

/** Live thinking buffer (partial). Shown in summary, not as a new line every delta. */
export function ingestThinking(full) {
  state.thinking = String(full || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** @deprecated Prefer ingestStep — kept for stderr noise. */
export function ingestChunk(chunk) {
  const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  for (const part of text.split(/\r?\n/)) {
    const line = part.trim();
    if (!line || line.startsWith("{")) continue;
    if (line.length > 200) {
      pushLine(`${line.slice(0, 140)}…`);
    } else {
      pushLine(line.slice(0, 160));
    }
  }
}

export function snapshot() {
  const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  const steps = state.lines.slice();
  if (state.running && state.thinking) {
    steps.push(`Thinking: ${state.thinking}`);
  }
  return {
    running: state.running,
    model: state.model,
    elapsedMs,
    lines: steps,
    raw: recentLines(40),
    summary: state.running
      ? state.thinking
        ? `Thinking… ${secs}s`
        : `Working… ${secs}s`
      : state.lines[state.lines.length - 1] || "",
  };
}
