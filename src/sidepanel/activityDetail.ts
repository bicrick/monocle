/** Parse streamed Cursor / patch dumps into labeled, readable sections. */

import { isPayloadText, matchThinkingLine } from "../shared/activityTalk";

const FIELD_META: Record<string, { label: string; lang: FieldLang }> = {
  css: { label: "CSS", lang: "css" },
  overlayHtml: { label: "Overlay HTML", lang: "html" },
  runtime: { label: "Runtime", lang: "js" },
  message: { label: "Message", lang: "text" },
  ops: { label: "Ops", lang: "json" },
};

const STEP_RE =
  /^(Working|Thinking|Asking|Writing|Done|Error|Model|Reading|Applying|Repairing|Starting|Failed|Page snapshot)\b|^[→✓]/;

export type FieldLang = "css" | "html" | "js" | "json" | "text";

export interface ActivityField {
  key: string;
  label: string;
  lang: FieldLang;
  value: string;
}

export interface ParsedActivityDetail {
  steps: string[];
  thinking: string | null;
  fields: ActivityField[];
  /** Used when nothing structured could be recovered. */
  fallback: string | null;
}

export function parseActivityDetail(raw: string): ParsedActivityDetail {
  const text = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { steps: [], thinking: null, fields: [], fallback: null };

  const { steps, rest, thinking } = splitSteps(text);
  const fields = rest ? extractFields(rest) : [];

  if (!fields.length && !steps.length && !thinking) {
    return { steps: [], thinking: null, fields: [], fallback: text };
  }
  if (!fields.length && !thinking && steps.join("\n") === text) {
    return { steps, thinking: null, fields: [], fallback: null };
  }
  if (!fields.length && rest) {
    if (steps.length || thinking) {
      const obscured = isPayloadText(rest);
      return {
        steps,
        thinking,
        fields: [
          {
            key: obscured ? "edit" : "output",
            label: obscured ? "Writing restyle" : "Output",
            lang: "text",
            value: rest,
          },
        ],
        fallback: null,
      };
    }
    return { steps: [], thinking: null, fields: [], fallback: text };
  }
  return { steps, thinking, fields, fallback: null };
}

export function formatCss(input: string): string {
  const src = input.trim();
  if (!src) return src;
  let out = "";
  let depth = 0;
  let paren = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (quote) {
      out += ch;
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "(") {
      paren += 1;
      out += ch;
      continue;
    }
    if (ch === ")") {
      paren = Math.max(0, paren - 1);
      out += ch;
      continue;
    }
    if (paren > 0) {
      out += ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out = out.replace(/[ \t]+$/, "");
      out += " {\n" + "  ".repeat(depth);
      while (src[i + 1] === " ") i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      out = out.replace(/[ \t]+$/, "");
      if (!out.endsWith("\n")) out += "\n";
      out += "  ".repeat(depth) + "}";
      if (src[i + 1] && src[i + 1] !== "}" && src[i + 1] !== "\n") {
        out += "\n" + "  ".repeat(depth);
      }
      while (src[i + 1] === " ") i += 1;
      continue;
    }
    if (ch === ";") {
      out += ";\n" + "  ".repeat(depth);
      while (src[i + 1] === " ") i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function formatHtml(input: string): string {
  const src = input.trim();
  if (!src) return src;
  const parts = src.split(/(<[^>]+>)/);
  let depth = 0;
  const lines: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (/^<\/\w/.test(part)) {
      depth = Math.max(0, depth - 1);
      lines.push("  ".repeat(depth) + part);
      continue;
    }
    if (part.startsWith("<") && !part.startsWith("<!") && !part.startsWith("<?")) {
      const voidish =
        /\/\s*>$/.test(part) ||
        /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b/i.test(
          part,
        );
      lines.push("  ".repeat(depth) + part);
      if (!voidish) depth += 1;
      continue;
    }
    if (part.startsWith("<")) {
      lines.push("  ".repeat(depth) + part);
      continue;
    }
    const text = part.trim();
    if (text) lines.push("  ".repeat(depth) + text);
  }
  return lines.join("\n");
}

function splitSteps(text: string): {
  steps: string[];
  rest: string;
  thinking: string | null;
} {
  const steps: string[] = [];
  const rest: string[] = [];
  let thinking: string | null = null;
  let sawPayload = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!sawPayload) {
      const thought = matchThinkingLine(trimmed);
      if (thought) {
        thinking = thought;
        continue;
      }
      if (isStepLine(trimmed)) {
        steps.push(trimmed);
        continue;
      }
    }
    sawPayload = true;
    rest.push(line);
  }
  return { steps, rest: rest.join("\n").trim(), thinking };
}

function isStepLine(line: string): boolean {
  if (STEP_RE.test(line)) return true;
  if (line.length <= 80 && !/[{<"]/.test(line) && /…|\.\.\./.test(line)) {
    return true;
  }
  return false;
}

function extractFields(rest: string): ActivityField[] {
  const fromObject = fieldsFromObject(tryParseObject(rest));
  if (fromObject.length) return fromObject;

  const collected: ActivityField[] = [];
  let leftover = rest;

  for (const key of ["message", "css", "overlayHtml", "runtime"] as const) {
    const extracted = extractJsonStringField(rest, key);
    if (extracted == null) continue;
    collected.push(fieldFromKey(key, extracted.value));
    leftover = leftover.replace(extracted.span, "");
  }

  const ops = extractJsonArrayField(rest, "ops");
  if (ops) {
    collected.push(fieldFromKey("ops", formatOps(ops.value)));
    leftover = leftover.replace(ops.span, "");
  }

  leftover = leftover
    .replace(/"(css|overlayHtml|runtime|message|ops)"\s*:\s*/g, "")
    .replace(/^[\s,{[]+|[\s,}\]]+$/g, "")
    .replace(/^"|"$/g, "")
    .trim();

  if (leftover && leftover.length > 8) {
    const cleaned = stripJsonPunctuation(leftover);
    if (looksLikeCss(cleaned)) {
      const existing = collected.find((f) => f.key === "css");
      const css = formatCss(cleaned);
      if (existing) existing.value = `${existing.value}\n${css}`.trim();
      else collected.unshift(fieldFromKey("css", cleaned));
    } else if (looksLikeHtml(cleaned)) {
      collected.push(fieldFromKey("overlayHtml", unescapeLoose(cleaned)));
    }
  }

  return collected.filter((f) => f.value.trim());
}

function fieldsFromObject(obj: Record<string, unknown> | null): ActivityField[] {
  if (!obj) return [];
  const fields: ActivityField[] = [];
  if (typeof obj.message === "string" && obj.message.trim()) {
    fields.push(fieldFromKey("message", obj.message));
  }
  if (typeof obj.css === "string" && obj.css.trim()) {
    fields.push(fieldFromKey("css", obj.css));
  }
  if (typeof obj.overlayHtml === "string" && obj.overlayHtml.trim()) {
    fields.push(fieldFromKey("overlayHtml", obj.overlayHtml));
  }
  if (Array.isArray(obj.ops) && obj.ops.length) {
    fields.push(fieldFromKey("ops", formatOps(obj.ops)));
  }
  if (typeof obj.runtime === "string" && obj.runtime.trim()) {
    fields.push(fieldFromKey("runtime", obj.runtime));
  }
  return fields;
}

function fieldFromKey(key: string, value: string): ActivityField {
  const meta = FIELD_META[key] || { label: key, lang: "text" as const };
  let formatted = value.trim();
  if (meta.lang === "css") formatted = formatCss(formatted);
  if (meta.lang === "html") formatted = formatHtml(unescapeLoose(formatted));
  return { key, label: meta.label, lang: meta.lang, value: formatted };
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // incomplete stream — fall through to field extractors
    }
  }
  return null;
}

function extractJsonStringField(
  text: string,
  key: string,
): { value: string; span: string } | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = re.exec(text);
  if (!match || match.index == null) return null;
  const quoteAt = match.index + match[0].length - 1;
  const read = readJsonString(text, quoteAt);
  if (!read) return null;
  return read;
}

function extractJsonArrayField(
  text: string,
  key: string,
): { value: unknown[]; span: string } | null {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const match = re.exec(text);
  if (!match || match.index == null) return null;
  const start = match.index + match[0].length - 1;
  const slice = readBalanced(text, start, "[", "]");
  if (!slice) return null;
  try {
    const value = JSON.parse(slice.value) as unknown;
    if (!Array.isArray(value)) return null;
    return { value, span: slice.span };
  } catch {
    return null;
  }
}

function readJsonString(
  text: string,
  quoteIndex: number,
): { value: string; span: string } | null {
  if (text[quoteIndex] !== '"') return null;
  let i = quoteIndex + 1;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next == null) break;
      if (next === "u" && i + 5 < text.length) {
        const hex = text.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        out += Number.isFinite(code) ? String.fromCharCode(code) : next;
        i += 6;
        continue;
      }
      const map: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        '"': '"',
        "\\": "\\",
        "/": "/",
      };
      out += map[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: out, span: text.slice(quoteIndex - 0, i + 1) };
    }
    out += ch;
    i += 1;
  }
  if (!out) return null;
  return { value: out, span: text.slice(quoteIndex, i) };
}

function readBalanced(
  text: string,
  start: number,
  open: string,
  close: string,
): { value: string; span: string } | null {
  if (text[start] !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const value = text.slice(start, i + 1);
        return { value, span: value };
      }
    }
  }
  return null;
}

function formatOps(ops: unknown[]): string {
  const lines: string[] = [];
  for (const item of ops) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    const type = typeof op.type === "string" ? op.type : "op";
    const selector = typeof op.selector === "string" ? op.selector : "";
    lines.push(selector ? `${type}  ${selector}` : type);
  }
  return lines.length ? lines.join("\n") : JSON.stringify(ops, null, 2);
}

function looksLikeCss(text: string): boolean {
  return /[{;]/.test(text) && /[\w-]+\s*:/.test(text);
}

function looksLikeHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

function stripJsonPunctuation(text: string): string {
  return text
    .replace(/^\s*",\s*/, "")
    .replace(/",\s*$/, "")
    .replace(/\\"/g, '"')
    .trim();
}

function unescapeLoose(value: string): string {
  if (!value.includes("\\")) return value;
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}
