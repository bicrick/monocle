/**
 * Full companion + Cursor CLI transcript.
 * Written to logs/companion.log, echoed to the companion terminal,
 * and served on GET /logs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_PATH =
  process.env.MONACLE_LOG || path.join(LOG_DIR, "companion.log");
const MAX_RING = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const ring = [];

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < MAX_FILE_BYTES) return;
    const bak = `${LOG_PATH}.1`;
    fs.rmSync(bak, { force: true });
    fs.renameSync(LOG_PATH, bak);
  } catch {
    // first write or race — ignore
  }
}

export function logPath() {
  return LOG_PATH;
}

export function writeLog(line, { echo = true, ring: useRing = true } = {}) {
  const text = stripAnsi(line).replace(/\s+$/, "");
  if (!text) return;
  const stamped = `${new Date().toISOString()} ${text}`;
  if (echo) console.log(stamped);
  if (useRing) {
    ring.push(stamped);
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
  }
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, `${stamped}\n`);
  } catch (err) {
    console.error("companion log write failed:", err);
  }
}

export function ingestRaw(chunk, stream = "out") {
  const text = stripAnsi(chunk);
  for (const part of text.split(/\r?\n/)) {
    const line = part.trimEnd();
    // Raw NDJSON: file only — not terminal, not the UI ring buffer.
    if (line) writeLog(`[${stream}] ${line}`, { echo: false, ring: false });
  }
}

export function recentLines(n = 200) {
  return ring.slice(-n);
}

export function recentText(n = 200) {
  return recentLines(n).join("\n");
}
