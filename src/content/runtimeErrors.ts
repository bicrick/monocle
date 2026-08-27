/** Report sandbox/runtime failures without taking down the applied scene. */

export function reportRuntimeError(message: string, fatal = false): void {
  const text = message.trim() || "Scene runtime failed";
  console.warn("[Monacle] sandbox runtime:", text);
  try {
    void chrome.runtime.sendMessage({
      type: "RUNTIME_ERROR",
      message: text,
      fatal,
    });
  } catch {
    // extension context gone
  }
}
