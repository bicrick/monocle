/** Detect a dead extension world so HMR / reloads cannot take the page down. */

export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export function isTransientHostError(message: string): boolean {
  return /extension context invalidated|HMRPort is not initialized|Could not establish connection|Receiving end does not exist/i.test(
    message,
  );
}

/** Swallow CRXJS HMR "Extension context invalidated" so it is not a page crash. */
export function swallowInvalidatedErrors(): void {
  const handle = (event: Event) => {
    const msg =
      event instanceof ErrorEvent
        ? String(event.message || event.error || "")
        : event instanceof PromiseRejectionEvent
          ? String(
              (event.reason as { message?: string } | undefined)?.message ||
                event.reason ||
                "",
            )
          : "";
    if (!isTransientHostError(msg)) return;
    event.preventDefault();
  };
  self.addEventListener("error", handle);
  self.addEventListener("unhandledrejection", handle);
}
