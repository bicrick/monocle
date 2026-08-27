/**
 * Detect model runtime that will crash or no-op in the extension sandbox.
 *
 * Real Three.js runs in the page (tab process) via monacle.three.* host commands.
 * Raw WebGLRenderer / CDN Three / getContext('webgl') in the sandbox are rejected.
 * Canvas 2d via monacle.canvas() is disabled — use monacle.create for DOM motion.
 */

const FORBIDDEN_EXTENSION_API_RE = /\b(?:chrome|browser)\s*\./;

const WEBGL_CONTEXT_RE =
  /getContext\s*\(\s*['"`](?:webgl2?|experimental-webgl)\b/i;

const CANVAS_API_RE =
  /\bmonacle\s*\.\s*canvas\s*\(|getContext\s*\(\s*['"`]2d\b/i;

/** Raw Three / WebGL in sandbox — NOT monacle.three host API. */
const RAW_THREE_RE =
  /\bTHREE\s*\.|\bnew\s+THREE\b|\bWebGLRenderer\b|\bWebGLRenderTarget\b/;

const CDN_RE =
  /https?:\/\/[^'"\s`]*(?:jsdelivr|unpkg\.com|esm\.sh|skypack|cdnjs\.cloudflare)/i;

const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

export function isExtensionApiRuntime(code: string): boolean {
  return FORBIDDEN_EXTENSION_API_RE.test(code);
}

/** Human-readable block reason, or null if the runtime may run. */
export function unsupportedRuntimeReason(code: string): string | null {
  if (!code || !code.trim()) return null;
  if (isExtensionApiRuntime(code)) {
    return "Runtime rejected: chrome/browser APIs are not allowed";
  }
  if (CDN_RE.test(code)) {
    return "External CDN scripts are blocked by sandbox CSP. Use monacle.three.* or monacle.create().";
  }
  if (DYNAMIC_IMPORT_RE.test(code)) {
    return "Dynamic import() is unsupported in the sandbox. Use monacle.three.* or monacle.create().";
  }
  if (WEBGL_CONTEXT_RE.test(code)) {
    return "Raw WebGL is unsupported. Use monacle.three.* for 3D (page-world stage).";
  }
  if (RAW_THREE_RE.test(code)) {
    return "Raw THREE / WebGLRenderer is unsupported. Use monacle.three.* (bundled page stage).";
  }
  if (CANVAS_API_RE.test(code)) {
    return "monacle.canvas() / getContext('2d') are disabled. Use monacle.create() for DOM motion.";
  }
  return null;
}

export function isWebglContextType(type: unknown): boolean {
  const t = String(type ?? "").toLowerCase();
  return t === "webgl" || t === "webgl2" || t === "experimental-webgl";
}
