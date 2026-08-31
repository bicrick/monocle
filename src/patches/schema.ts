import type { InsertPosition, Patch, PatchOp } from "../shared/types";
import {
  isExtensionApiRuntime,
  unsupportedRuntimeReason,
} from "../sandbox/runtimePolicy";

export { unsupportedRuntimeReason };

const MEDIA_TAGS = new Set(["VIDEO", "AUDIO"]);

/** Selectors that typically wrap media players — never destroy these. */
const PROTECTED_ANCESTOR_RE =
  /#(movie_player|player|player-container|ytd-player|html5-video-player)|ytd-player|video-stream/i;

const INSERT_POSITIONS = new Set<InsertPosition>([
  "before",
  "after",
  "prepend",
  "append",
]);

export function isProtectedElement(el: Element): boolean {
  if (MEDIA_TAGS.has(el.tagName)) return true;
  if (el.querySelector("video, audio")) return true;
  if (
    PROTECTED_ANCESTOR_RE.test(el.id) ||
    PROTECTED_ANCESTOR_RE.test(el.className?.toString?.() ?? "")
  ) {
    return true;
  }
  return false;
}

/** True unless the runtime clearly reaches extension APIs (blocks whole patch). */
export function isRuntimeSourceAllowed(code: string): boolean {
  return !isExtensionApiRuntime(code);
}

export function validatePatch(raw: unknown): Patch | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const patch: Patch = {};

  if (typeof obj.css === "string") patch.css = obj.css;
  if (typeof obj.overlayHtml === "string") patch.overlayHtml = obj.overlayHtml;
  if (typeof obj.message === "string") patch.message = obj.message;
  if (typeof obj.runtime === "string") {
    if (!isRuntimeSourceAllowed(obj.runtime)) return null;
    patch.runtime = obj.runtime;
  }

  if (Array.isArray(obj.ops)) {
    const ops: PatchOp[] = [];
    for (const item of obj.ops) {
      if (!item || typeof item !== "object") continue;
      const op = item as Record<string, unknown>;
      const type = op.type;
      if (
        type !== "hide" &&
        type !== "show" &&
        type !== "wrap" &&
        type !== "move" &&
        type !== "restyle" &&
        type !== "insert" &&
        type !== "remove"
      ) {
        continue;
      }
      if (typeof op.selector !== "string" || !op.selector.trim()) continue;
      const normalized: PatchOp = {
        type,
        selector: op.selector.trim(),
      };
      if (op.css && typeof op.css === "object" && !Array.isArray(op.css)) {
        const css: Record<string, string> = {};
        for (const [k, v] of Object.entries(op.css as Record<string, unknown>)) {
          if (typeof v === "string") css[k] = v;
        }
        normalized.css = css;
      }
      if (typeof op.wrapTag === "string") normalized.wrapTag = op.wrapTag;
      if (typeof op.wrapClass === "string") normalized.wrapClass = op.wrapClass;
      if (typeof op.targetSelector === "string") {
        normalized.targetSelector = op.targetSelector;
      }
      if (typeof op.html === "string") normalized.html = op.html;
      if (
        typeof op.position === "string" &&
        INSERT_POSITIONS.has(op.position as InsertPosition)
      ) {
        normalized.position = op.position as InsertPosition;
      }
      if (type === "insert" && !normalized.html) continue;
      ops.push(normalized);
    }
    if (ops.length) patch.ops = ops;
  }

  if (
    !patch.css &&
    !patch.overlayHtml &&
    !patch.ops?.length &&
    !patch.runtime &&
    !patch.message
  ) {
    return null;
  }
  return patch;
}

/** True when the patch changes the page (not message-only chat). */
export function isVisualPatch(patch: Patch): boolean {
  return Boolean(
    patch.css ||
      patch.overlayHtml ||
      (patch.ops && patch.ops.length > 0) ||
      patch.runtime,
  );
}

/** Try to extract a Patch from model text (JSON block or fenced). */
export function extractPatchFromText(text: string): Patch | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (m) => m[1],
  );
  // Prefer the last fence (final answer after tool narration), then bare text.
  const candidates = [...fences.reverse(), text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      const patch = validatePatch(parsed);
      if (patch) return patch;
    } catch {
      // keep trying
    }
  }
  return null;
}

/**
 * Detect a javascript fence. Used as live `runtime` when no JSON patch is present.
 */
export function extractCodeFromText(text: string): string | null {
  const fenced = text.match(/```(?:javascript|js)\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    const code = fenced[1].trim();
    if (!isRuntimeSourceAllowed(code)) return null;
    return code;
  }
  return null;
}

/** Build a runtime-only patch from a JS fence (live page, not sandbox). */
export function patchFromRuntimeCode(code: string): Patch | null {
  if (!code.trim() || !isRuntimeSourceAllowed(code)) return null;
  return { runtime: code, message: "Applied live runtime." };
}
