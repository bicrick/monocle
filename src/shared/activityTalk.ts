/**
 * Map companion /status (and activity detail dumps) into a Cursor-style
 * talk line: verb + latest thought, with CSS/JSON/runtime edits obscured.
 */

export interface CliStatusSnapshot {
  running?: boolean;
  summary?: string;
  model?: string | null;
  thinking?: string;
  hasPayload?: boolean;
  payload?: string;
  lines?: string[];
  raw?: string[];
}

export interface ActivityTalk {
  /** Short shimmer verb — Thinking / Writing / Reading. */
  verb: string;
  /** Latest human sentence or step. Never raw payload. */
  talk: string;
  thinking: string;
  steps: string[];
  hasEdit: boolean;
  /** Raw patch dump for collapsed expand only — never the talk line. */
  payload: string;
}

export interface TalkLine {
  label: string;
  detail?: string;
  thinking?: string;
  ts?: number;
  state?: string;
}

const GENERIC_LABEL =
  /^(Continuing chat|Asking Cursor|Starting|waiting…|Working…|Thought)$/i;

const META_STEP = /^(Working…|Thinking…|Asking |waiting…|Model )/i;

const EDIT_FIELD_RE = /"(css|overlayHtml|runtime|ops)"\s*:/;

const WRITE_STEP = /^(Writing restyle|Writing restyle patch|Editing scene)/i;

export function isGenericActivityLabel(label: string): boolean {
  return GENERIC_LABEL.test((label || "").trim());
}

export function isPayloadText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (EDIT_FIELD_RE.test(t)) return true;
  if (t.startsWith("```") && (t.includes("{") || /html\[data-monacle/.test(t))) {
    return true;
  }
  if (t.startsWith("{") && t.includes(":") && t.length > 20) return true;
  return false;
}

export function obscureEditLabel(text: string): string {
  const t = text || "";
  if (/"runtime"\s*:/.test(t) && !/"css"\s*:/.test(t) && !/"overlayHtml"\s*:/.test(t)) {
    return "Editing scene";
  }
  return "Writing restyle";
}

export function matchThinkingLine(line: string): string | null {
  const m = /^Thinking:\s*(.+)$/i.exec((line || "").trim());
  return m ? m[1].trim() : null;
}

function lastHumanStep(steps: string[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s || META_STEP.test(s)) continue;
    if (matchThinkingLine(s)) continue;
    return s;
  }
  return "";
}

function verbFrom(thinking: string, lastStep: string, hasEdit: boolean): string {
  if (hasEdit || WRITE_STEP.test(lastStep)) return "Writing";
  if (/^Reading\b|^Page snapshot\b|^→\s*Read\b/i.test(lastStep)) return "Reading";
  if (/^Applying\b|^Repairing\b/i.test(lastStep)) return "Applying";
  if (/^[→✓]\s+/.test(lastStep)) {
    const name = lastStep.replace(/^[→✓]\s+/, "").split(/\s+/)[0] || "";
    if (name && name.length <= 18) return name;
  }
  if (thinking || lastStep) return "Thinking";
  return "Thinking";
}

function pickTalk(
  thinking: string,
  lastStep: string,
  hasEdit: boolean,
): string {
  if (thinking) return thinking;
  if (lastStep) return lastStep;
  if (hasEdit) return "Writing restyle";
  return "";
}

function collectFromLines(raw: string[]): {
  steps: string[];
  thinking: string;
  hasEdit: boolean;
  payload: string;
} {
  const steps: string[] = [];
  const payloadParts: string[] = [];
  let thinking = "";
  let hasEdit = false;
  let sawPayload = false;
  for (const line of raw) {
    const t = String(line || "").trim();
    if (!t) continue;
    if (
      sawPayload ||
      isPayloadText(t) ||
      t.startsWith("{") ||
      t.startsWith("```")
    ) {
      sawPayload = true;
      hasEdit = true;
      payloadParts.push(line);
      continue;
    }
    const thought = matchThinkingLine(t);
    if (thought) {
      thinking = thought;
      continue;
    }
    if (WRITE_STEP.test(t)) hasEdit = true;
    steps.push(t);
  }
  return {
    steps,
    thinking,
    hasEdit,
    payload: payloadParts.join("\n").trim(),
  };
}

export function interpretStatus(input: CliStatusSnapshot | string): ActivityTalk {
  let thinking = "";
  let steps: string[] = [];
  let hasEdit = false;
  let payload = "";

  if (typeof input === "string") {
    const parsed = collectFromLines(input.replace(/\r\n/g, "\n").split("\n"));
    thinking = parsed.thinking;
    steps = parsed.steps;
    hasEdit = parsed.hasEdit;
    payload = parsed.payload;
  } else {
    thinking = String(input.thinking || "").trim();
    payload = String(input.payload || "").trim();
    hasEdit = Boolean(input.hasPayload || payload);
    const raw = input.lines?.length ? input.lines : (input.raw ?? []);
    const parsed = collectFromLines(raw);
    steps = parsed.steps;
    if (parsed.thinking) thinking = parsed.thinking;
    if (parsed.hasEdit) hasEdit = true;
    if (parsed.payload) payload = parsed.payload;
    if (payload && isPayloadText(payload)) hasEdit = true;
  }

  if (hasEdit && !steps.some((s) => WRITE_STEP.test(s))) {
    steps.push("Writing restyle");
  }

  const lastStep = lastHumanStep(steps);
  return {
    verb: verbFrom(thinking, lastStep, hasEdit),
    talk: pickTalk(thinking, lastStep, hasEdit),
    thinking,
    steps,
    hasEdit,
    payload,
  };
}

/** Steps + thinking only — never raw CSS/JSON/runtime. */
export function formatStatusDetail(talk: ActivityTalk): string {
  const parts: string[] = [];
  for (const step of talk.steps) {
    if (isPayloadText(step)) continue;
    parts.push(step);
  }
  if (talk.thinking) parts.push(`Thinking: ${talk.thinking}`);
  if (talk.hasEdit && !parts.some((s) => WRITE_STEP.test(s))) {
    parts.push("Writing restyle");
  }
  return parts.join("\n");
}

/** Talk lines plus collapsed-behind-click payload. */
export function formatExpandDetail(talk: ActivityTalk): string {
  const head = formatStatusDetail(talk);
  if (!talk.payload) return head;
  return head ? `${head}\n${talk.payload}` : talk.payload;
}

export function interpretActivityLine(line: TalkLine): ActivityTalk {
  const fromDetail = interpretStatus(line.detail || "");
  const thinking = (line.thinking || fromDetail.thinking).trim();
  const hasEdit = fromDetail.hasEdit;
  const steps = fromDetail.steps.slice();
  if (
    line.label &&
    !isGenericActivityLabel(line.label) &&
    line.label !== "Thinking" &&
    !steps.includes(line.label)
  ) {
    steps.unshift(line.label);
  }
  const lastStep = lastHumanStep(steps);
  return {
    verb: verbFrom(thinking, lastStep, hasEdit),
    talk: pickTalk(thinking, lastStep, hasEdit),
    thinking,
    steps,
    hasEdit,
    payload: fromDetail.payload,
  };
}

export function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

/** Always at least 1s. Prefer startedAt; else first/last activity timestamps. */
export function thoughtDurationMs(
  lines: TalkLine[],
  startedAt: number | null,
  now = Date.now(),
): number {
  if (startedAt != null) return Math.max(1000, now - startedAt);
  const times = lines
    .map((l) => l.ts)
    .filter((t): t is number => typeof t === "number" && t > 0);
  if (times.length >= 2) {
    return Math.max(1000, times[times.length - 1] - times[0]);
  }
  if (times.length === 1) return Math.max(1000, now - times[0]);
  return 1000;
}

export function formatThoughtTitle(ms: number): string {
  return `Thought for ${formatDuration(ms)}`;
}

export function idleActivityTitle(
  lines: TalkLine[],
  startedAt: number | null,
  now = Date.now(),
): string {
  const last = lines[lines.length - 1];
  if (last?.state === "error") return "Failed";
  return formatThoughtTitle(thoughtDurationMs(lines, startedAt, now));
}
