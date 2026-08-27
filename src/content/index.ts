import type { RuntimeMessage } from "../shared/types";
import { captureSnapshot } from "./snapshot";
import {
  applyPatch,
  clearMemory,
  hasActivePatch,
  reassertPatch,
  rememberPatch,
  resetPatch,
} from "./applicator";

let lastUrl = location.href;

function onRouteMaybeChanged(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  // SPA navigated — reassert CSS hides if a restyle is active
  reassertPatch();
}

const routeObserver = new MutationObserver(() => onRouteMaybeChanged());
routeObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

window.addEventListener("popstate", onRouteMaybeChanged);
const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function (...args) {
  origPush(...args);
  onRouteMaybeChanged();
};
history.replaceState = function (...args) {
  origReplace(...args);
  onRouteMaybeChanged();
};

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    // Panel→background messages may also arrive here; ignore those.
    if (
      message.type === "PROMPT" ||
      message.type === "GET_TAB_STATE" ||
      message.type === "GET_SETTINGS" ||
      message.type === "SAVE_SETTINGS" ||
      message.type === "OPEN_OPTIONS" ||
      message.type === "AGENT_EVENT" ||
      message.type === "RUN_SANDBOX" ||
      message.type === "LIST_SESSIONS" ||
      message.type === "OPEN_SESSION" ||
      message.type === "NEW_SESSION" ||
      (message.type === "RESET" && "tabId" in message && message.tabId != null)
    ) {
      return false;
    }

    if (message.type === "GET_SNAPSHOT") {
      sendResponse({ type: "SNAPSHOT", context: captureSnapshot() });
      return true;
    }
    if (message.type === "APPLY_PATCH") {
      try {
        rememberPatch(message.patch);
        applyPatch(message.patch);
        sendResponse({ type: "PATCH_APPLIED", ok: true });
      } catch (err) {
        sendResponse({
          type: "PATCH_APPLIED",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (message.type === "RESET") {
      resetPatch();
      clearMemory();
      sendResponse({ type: "RESET_DONE" });
      return true;
    }
    return false;
  },
);

// Expose for debugging in page console via content-script world is not needed.
void hasActivePatch;
