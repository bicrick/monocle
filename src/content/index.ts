import type { RuntimeMessage } from "../shared/types";
import {
  isExtensionContextValid,
  swallowInvalidatedErrors,
} from "./extensionContext";
import { isolate } from "./isolate";
import { captureSnapshot } from "./snapshot";
import { capturePageRead } from "./pageRead";
import {
  applyPatch,
  clearMemory,
  hasActivePatch,
  reassertPatch,
  rememberPatch,
  resetPatch,
} from "./applicator";
import { getLastRuntime } from "./runtime";
import { prewarmSandboxFrame } from "./sandboxFrame";

swallowInvalidatedErrors();

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
      message.type === "RUNTIME_ERROR" ||
      message.type === "RUN_SANDBOX" ||
      message.type === "LIST_SESSIONS" ||
      message.type === "OPEN_SESSION" ||
      message.type === "NEW_SESSION" ||
      message.type === "DELETE_SESSION" ||
      message.type === "INJECT_THREE_STAGE" ||
      message.type === "CONTENT_READY" ||
      (message.type === "RESET" && "tabId" in message && message.tabId != null)
    ) {
      return false;
    }

    if (message.type === "PING") {
      sendResponse({
        ok: true,
        hasPatch: hasActivePatch(),
        runtimeLive: Boolean(getLastRuntime()),
      });
      return true;
    }
    if (message.type === "GET_SNAPSHOT") {
      const snap = isolate(captureSnapshot, {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        landmarks: [],
        media: [],
        capturedAt: Date.now(),
      });
      sendResponse({ type: "SNAPSHOT", context: snap.value });
      return true;
    }
    if (message.type === "GET_PAGE_READ") {
      const read = isolate(capturePageRead, {
        url: location.href,
        title: document.title,
        text: "",
        links: [],
        capturedAt: Date.now(),
      });
      sendResponse({ type: "PAGE_READ", page: read.value });
      return true;
    }
    if (message.type === "APPLY_PATCH") {
      const applied = isolate(() => {
        rememberPatch(message.patch);
        return applyPatch(message.patch);
      }, {
        ok: true,
        error: "apply failed",
        runtimeStarted: false,
      });
      const result = applied.value;
      if (applied.error) {
        result.error = result.error || applied.error;
        result.opErrors = [...(result.opErrors ?? []), applied.error];
      }
      sendResponse({ type: "PATCH_APPLIED", ...result });
      return true;
    }
    if (message.type === "RESET") {
      isolate(() => {
        resetPatch();
        clearMemory();
      }, undefined);
      sendResponse({ type: "RESET_DONE" });
      return true;
    }
    return false;
  },
);

function announceReady(): void {
  if (!isExtensionContextValid()) return;
  try {
    void chrome.runtime.sendMessage({
      type: "CONTENT_READY",
      hasPatch: hasActivePatch(),
      runtimeLive: Boolean(getLastRuntime()),
    });
  } catch {
    // service worker gone — next prompt injects again
  }
}

prewarmSandboxFrame();
announceReady();

// Expose for debugging in page console via content-script world is not needed.
void hasActivePatch;
