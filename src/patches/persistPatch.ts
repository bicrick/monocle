import type { Patch } from "../shared/types";

/** chrome.storage.local is large enough for scenes; still cap a runaway runtime. */
export const MAX_PERSISTED_PATCH_CHARS = 400_000;

/** Copy a patch for session storage. Drop runtime only if the blob is huge. */
export function persistablePatch(
  patch: Patch,
  maxChars = MAX_PERSISTED_PATCH_CHARS,
): Patch {
  const copy: Patch = { ...patch };
  if (copy.ops) copy.ops = copy.ops.map((op) => ({ ...op }));
  const encoded = JSON.stringify(copy);
  if (encoded.length > maxChars && copy.runtime) {
    delete copy.runtime;
  }
  return copy;
}
