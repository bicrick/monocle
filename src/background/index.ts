import type {
  ActivityLine,
  AgentEvent,
  AgentSession,
  ChatMessage,
  ChatSession,
  PageContext,
  Patch,
  PromptImage,
  RuntimeMessage,
  Settings,
} from "../shared/types";
import { createProvider, loadSettings, saveSettings } from "../agent";
import { isTransientHostError } from "../content/extensionContext";
import { isVisualPatch, validatePatch } from "../patches/schema";
import {
  ensureContentScript,
  isRestrictedUrl,
  pingTab,
  sendApplyPatch,
} from "./contentBridge";
import * as sessions from "./sessions";

self.addEventListener("error", (event) => {
  event.preventDefault();
  console.warn("[Monacle] service worker error", event.message);
});
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  console.warn("[Monacle] service worker rejection", event.reason);
});

/** Per-tab runtime cache — chat content lives in chrome.storage via sessions. */
interface TabRuntime {
  chatSessionId: string | null;
  agentSession: AgentSession | null;
  busy: boolean;
  hasPatch: boolean;
  lastContext: PageContext | null;
  activity: ActivityLine[];
  lastApplyAt: number;
  repairUsed: boolean;
  pendingRepair: string | null;
  abort: AbortController | null;
  cancelled: boolean;
}

const REPAIR_WINDOW_MS = 2000;

const tabs = new Map<number, TabRuntime>();

function getTab(tabId: number): TabRuntime {
  let state = tabs.get(tabId);
  if (!state) {
    state = {
      chatSessionId: null,
      agentSession: null,
      busy: false,
      hasPatch: false,
      lastContext: null,
      activity: [],
      lastApplyAt: 0,
      repairUsed: false,
      pendingRepair: null,
      abort: null,
      cancelled: false,
    };
    tabs.set(tabId, state);
  }
  return state;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      // older chrome
    });
  void reinjectSessionTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void reinjectSessionTabs();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

async function tabMeta(
  tabId: number,
): Promise<{ url: string; title: string }> {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || "", title: tab.title || "" };
}

async function ensureChatForTab(tabId: number): Promise<ChatSession> {
  const state = getTab(tabId);
  if (state.chatSessionId) {
    const existing = await sessions.getSession(state.chatSessionId);
    if (existing) return sessions.ensureGreeting(existing);
  }

  const meta = await tabMeta(tabId);
  if (meta.url) {
    const latest = await sessions.findLatestForUrl(meta.url);
    if (latest) {
      state.chatSessionId = latest.id;
      state.activity = latest.activity ?? [];
      return sessions.ensureGreeting(latest);
    }
  }

  const created = await sessions.createSession({
    url: meta.url || "about:blank",
    pageTitle: meta.title,
  });
  state.chatSessionId = created.id;
  state.activity = [];
  return created;
}

async function buildTabState(tabId: number): Promise<RuntimeMessage> {
  const state = getTab(tabId);
  const chat = await ensureChatForTab(tabId);
  const list = await sessions.listSessions();
  const meta = await tabMeta(tabId);
  return {
    type: "TAB_STATE",
    tabId,
    sessionId: chat.id,
    sessions: list,
    messages: chat.messages,
    busy: state.busy,
    hasPatch: state.hasPatch || Boolean(chat.lastPatch),
    activity: state.busy ? state.activity : chat.activity,
    pageUrl: meta.url,
    pageTitle: meta.title,
  };
}

const applyChain = new Map<number, Promise<void>>();

function waitForApply(tabId: number): Promise<void> {
  return applyChain.get(tabId) ?? Promise.resolve();
}

function enqueueApply<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = applyChain.get(tabId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  applyChain.set(
    tabId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function requestSnapshot(tabId: number): Promise<PageContext> {
  const res = (await chrome.tabs.sendMessage(tabId, {
    type: "GET_SNAPSHOT",
  })) as RuntimeMessage;
  if (res?.type !== "SNAPSHOT") {
    throw new Error("Could not capture page snapshot");
  }
  return res.context;
}

/** After HMR / SW restart, put a live content script back on pages we restyled. */
async function reinjectSessionTabs(): Promise<void> {
  const list = await sessions.listSessions();
  const keys = new Set(list.map((s) => s.urlKey));
  if (!keys.size) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null || !tab.url || isRestrictedUrl(tab.url)) continue;
    if (!keys.has(sessions.urlKeyFrom(tab.url))) continue;
    try {
      await ensureContentScript(tab.id);
    } catch {
      // restricted frame or no host access
    }
  }
}

async function restoreLastPatch(tabId: number): Promise<boolean> {
  const chat = await ensureChatForTab(tabId);
  if (!chat.lastPatch) return false;
  await applyPatchToTab(tabId, chat.lastPatch);
  getTab(tabId).hasPatch = true;
  return true;
}

async function getSnapshot(tabId: number): Promise<PageContext> {
  try {
    await ensureContentScript(tabId);
    return await requestSnapshot(tabId);
  } catch (err) {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url || "")) {
      throw new Error(
        "This page cannot run Monacle (chrome://, Web Store, or similar). Open a normal website tab.",
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Content script not ready (${reason}). Reload Monacle on chrome://extensions, then refresh this page.`,
    );
  }
}

async function applyPatchToTab(tabId: number, patch: Patch): Promise<{
  opErrors?: string[];
  runtimeStarted?: boolean;
}> {
  return enqueueApply(tabId, () => applyPatchToTabInner(tabId, patch));
}

async function applyPatchToTabInner(tabId: number, patch: Patch): Promise<{
  opErrors?: string[];
  runtimeStarted?: boolean;
}> {
  const tab = getTab(tabId);
  tab.lastApplyAt = Date.now();
  if (tab.chatSessionId) {
    await sessions.setLastPatch(tab.chatSessionId, patch);
  }
  try {
    await ensureContentScript(tabId);
    const res = await sendApplyPatch(tabId, patch);
    if (res?.type === "PATCH_APPLIED") {
      tab.hasPatch = Boolean(
        patch.css || patch.overlayHtml || patch.ops || res.runtimeStarted,
      );
      const opErrors = [...(res.opErrors ?? [])];
      if (!res.ok && res.error) opErrors.unshift(res.error);
      return { opErrors: opErrors.length ? opErrors : undefined, runtimeStarted: res.runtimeStarted };
    }
    tab.hasPatch = true;
    return {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { opErrors: [message], runtimeStarted: false };
  }
}

async function resetTab(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: "RESET" });
  getTab(tabId).hasPatch = false;
}

function broadcast(
  tabId: number,
  event: AgentEvent,
  sessionId?: string | null,
): void {
  chrome.runtime
    .sendMessage({
      type: "AGENT_EVENT",
      tabId,
      sessionId: sessionId ?? undefined,
      event,
    } satisfies RuntimeMessage)
    .catch(() => {
      // no listeners
    });
}

async function progress(
  tabId: number,
  sessionId: string,
  label: string,
  state: ActivityLine["state"] = "active",
  detail?: string,
): Promise<void> {
  const line: ActivityLine = { label, detail, ts: Date.now(), state };
  const runtime = getTab(tabId);
  const prev = runtime.activity[runtime.activity.length - 1];
  if (prev?.state === "active") prev.state = "done";
  runtime.activity.push(line);
  if (runtime.activity.length > 24) {
    runtime.activity = runtime.activity.slice(-24);
  }
  await sessions.setActivity(sessionId, runtime.activity);
  broadcast(tabId, { type: "progress", line }, sessionId);
}

async function pushMessage(
  tabId: number,
  sessionId: string,
  msg: ChatMessage,
): Promise<void> {
  await sessions.appendMessage(sessionId, msg);
  void tabId;
}

function repairPromptFor(error: string): string {
  return [
    "The previous restyle failed. The page and extension are still running.",
    `Error: ${error}`,
    "",
    "Keep any CSS, overlayHtml, and ops that still work. Emit a different JSON patch that avoids this failure. Do not repeat the same runtime.",
  ].join("\n");
}

function withRuntimeErrorHint(prompt: string, lastError?: string): string {
  if (!lastError?.trim()) return prompt;
  return `${prompt}\n\n[Monacle] Previous restyle failed (extension stayed up): ${lastError.trim()}. Keep working CSS/ops; emit a safer patch.`;
}

async function maybeStartRepair(
  tabId: number,
  error: string,
  fatal = false,
): Promise<void> {
  if (!fatal) return;
  if (isTransientHostError(error)) return;
  const runtime = getTab(tabId);
  if (runtime.repairUsed) return;
  if (!runtime.lastApplyAt || Date.now() - runtime.lastApplyAt > REPAIR_WINDOW_MS) {
    return;
  }
  if (runtime.busy) {
    runtime.pendingRepair = error;
    return;
  }
  runtime.repairUsed = true;
  runtime.pendingRepair = null;
  await handlePrompt(tabId, repairPromptFor(error), runtime.chatSessionId ?? undefined, undefined, {
    isRepair: true,
  });
}

async function stopCompanionRun(sessionId: string): Promise<void> {
  try {
    const settings = await loadSettings();
    const base = (settings.baseUrl || "http://127.0.0.1:8787").replace(
      /\/$/,
      "",
    );
    await fetch(`${base}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // companion offline or already gone
  }
}

async function handleStop(
  tabId: number,
  sessionIdHint?: string,
): Promise<void> {
  const runtime = getTab(tabId);
  const sessionId = sessionIdHint || runtime.chatSessionId;
  if (!runtime.busy) return;
  runtime.cancelled = true;
  runtime.pendingRepair = null;
  runtime.abort?.abort();
  if (sessionId) await stopCompanionRun(sessionId);
}

/** Drop a deleted chat from every tab so an in-flight run cannot revive it. */
async function forgetSession(sessionId: string): Promise<void> {
  for (const [tabId, runtime] of tabs) {
    if (runtime.chatSessionId !== sessionId) continue;
    if (runtime.busy) await handleStop(tabId, sessionId);
    runtime.chatSessionId = null;
    runtime.agentSession = null;
    runtime.activity = [];
    runtime.busy = false;
    runtime.abort = null;
    runtime.pendingRepair = null;
  }
}

async function handlePrompt(
  tabId: number,
  prompt: string,
  sessionIdHint?: string,
  images?: PromptImage[],
  opts?: { isRepair?: boolean },
): Promise<void> {
  const runtime = getTab(tabId);
  if (runtime.busy) return;
  runtime.busy = true;
  if (!opts?.isRepair) runtime.repairUsed = false;

  let chat: ChatSession | null = null;
  if (sessionIdHint) {
    chat = await sessions.getSession(sessionIdHint);
  }
  if (!chat) chat = await ensureChatForTab(tabId);
  runtime.chatSessionId = chat.id;
  const sessionId = chat.id;

  if (opts?.isRepair) {
    await pushMessage(tabId, sessionId, {
      role: "system",
      content: "Repairing the scene after a runtime error.",
      ts: Date.now(),
    });
  } else {
    await pushMessage(tabId, sessionId, {
      role: "user",
      content:
        images?.length && prompt === "Restyle based on the attached image(s)."
          ? ""
          : prompt,
      ts: Date.now(),
      images: images?.length ? images : undefined,
    });
  }
  runtime.cancelled = false;
  runtime.abort = new AbortController();
  runtime.activity = [];
  await progress(
    tabId,
    sessionId,
    opts?.isRepair ? "Repairing scene" : "Reading the page",
  );

  try {
    const provider = await createProvider();
    const context = await getSnapshot(tabId);
    if (runtime.cancelled) {
      await progress(tabId, sessionId, "Stopped", "done");
      return;
    }
    if (chat.lastRuntimeError) {
      context.lastRuntimeError = chat.lastRuntimeError;
    }
    runtime.lastContext = context;
    await sessions.touchPageMeta(sessionId, context.url, context.title);
    await progress(
      tabId,
      sessionId,
      "Page snapshot",
      "done",
      `${context.title}\n${context.url}`,
    );

    if (!runtime.agentSession || runtime.agentSession.id !== chat.id) {
      runtime.agentSession = {
        id: chat.id,
        tabId,
        kind: "persistent",
        pageUrl: context.url,
        createdAt: chat.createdAt,
        cursorSessionId: chat.cursorSessionId,
      };
    } else {
      runtime.agentSession.pageUrl = context.url;
      runtime.agentSession.cursorSessionId =
        chat.cursorSessionId || runtime.agentSession.cursorSessionId;
    }

    await progress(tabId, sessionId, "Thinking");

    const fresh = await sessions.getSession(sessionId);
    const llmHistory = fresh?.history ?? [];
    const sendPrompt = opts?.isRepair
      ? prompt
      : withRuntimeErrorHint(prompt, fresh?.lastRuntimeError);

    let assistantText = "";
    let applied = false;

    for await (const event of provider.send(
      runtime.agentSession,
      sendPrompt,
      llmHistory,
      context,
      images,
      undefined,
      runtime.abort?.signal,
    )) {
      if (runtime.cancelled || event.type === "stopped") {
        runtime.cancelled = true;
        break;
      }
      if (event.type === "cursor_session") {
        runtime.agentSession.cursorSessionId = event.cursorSessionId;
        await sessions.setCursorSessionId(sessionId, event.cursorSessionId);
        continue;
      }
      if (event.type === "text") {
        assistantText += event.text;
      } else if (event.type === "patch") {
        // Message-only JSON is a chat reply — do not apply or persist as a scene.
        if (!isVisualPatch(event.patch)) {
          const note = event.patch.message?.trim();
          // Prefer the JSON message over any earlier streamed intent prose.
          if (note) assistantText = note;
          else assistantText = stripModelNoise(assistantText);
          continue;
        }
        await progress(
          tabId,
          sessionId,
          event.patch.runtime ? "Applying scene" : "Applying restyle",
        );
        const appliedResult = await applyPatchToTab(tabId, event.patch);
        applied = true;
        await sessions.setLastRuntimeError(sessionId, undefined);
        if (appliedResult.opErrors?.length) {
          await progress(
            tabId,
            sessionId,
            "Scene applied with warnings",
            "done",
            appliedResult.opErrors.join("\n"),
          );
        }
        const note =
          event.patch.message?.trim() ||
          (event.patch.runtime ? "Applied scene." : "Applied restyle.");
        broadcast(tabId, { type: "text", text: note }, sessionId);
        broadcast(tabId, event, sessionId);
        // Conversational note wins over any pre-tool intent prose in the dump.
        assistantText = note;
      } else if (event.type === "code") {
        // Legacy: JS fence → live runtime patch (no sandbox).
        const patch = validatePatch({
          runtime: event.code,
          message: "Applied live runtime.",
        });
        if (patch) {
          await progress(tabId, sessionId, "Applying scene");
          await applyPatchToTab(tabId, patch);
          applied = true;
          await sessions.setLastRuntimeError(sessionId, undefined);
          const note = patch.message || "Applied scene.";
          assistantText = note;
          broadcast(tabId, { type: "text", text: note }, sessionId);
          broadcast(tabId, { type: "patch", patch }, sessionId);
        } else {
          broadcast(
            tabId,
            { type: "error", message: "Runtime code was rejected" },
            sessionId,
          );
        }
      } else if (event.type === "progress") {
        const last = runtime.activity[runtime.activity.length - 1];
        if (
          event.update &&
          last &&
          last.label === event.line.label &&
          last.state === "active"
        ) {
          last.detail = event.line.detail;
          last.ts = event.line.ts;
          last.thinking = event.line.thinking;
          await sessions.setActivity(sessionId, runtime.activity);
          broadcast(
            tabId,
            { type: "progress", line: { ...last }, update: true },
            sessionId,
          );
        } else {
          if (last?.state === "active") last.state = "done";
          runtime.activity.push(event.line);
          if (runtime.activity.length > 24) {
            runtime.activity = runtime.activity.slice(-24);
          }
          await sessions.setActivity(sessionId, runtime.activity);
          broadcast(tabId, { type: "progress", line: event.line }, sessionId);
        }
      } else if (event.type === "error") {
        await progress(tabId, sessionId, "Failed", "error", event.message);
        broadcast(tabId, event, sessionId);
        await pushMessage(tabId, sessionId, {
          role: "system",
          content: event.message,
          ts: Date.now(),
        });
      } else if (event.type === "done") {
        // Defer "done" until after persistence + busy clear (see finally).
        // Broadcasting early races refreshState against busy=true and sticks the UI.
        if (!applied && assistantText.trim()) {
          const cleaned = stripModelNoise(assistantText);
          if (cleaned) {
            broadcast(tabId, { type: "text", text: cleaned }, sessionId);
          }
        }
      }
    }

    assistantText = stripModelNoise(assistantText) || assistantText;

    if (runtime.cancelled) {
      await progress(tabId, sessionId, "Stopped", "done");
      broadcast(tabId, { type: "stopped" }, sessionId);
      return;
    }

    if (assistantText.trim()) {
      await pushMessage(tabId, sessionId, {
        role: "assistant",
        content: assistantText.trim(),
        ts: Date.now(),
      });
      const updated = await sessions.getSession(sessionId);
      if (updated) {
        updated.history.push({ role: "user", content: sendPrompt });
        updated.history.push({
          role: "assistant",
          content: assistantText.trim(),
        });
        await sessions.saveSession(updated);
      }
    }

    if (applied) {
      await progress(tabId, sessionId, "Applied scene", "done");
    } else if (!assistantText.trim()) {
      broadcast(
        tabId,
        { type: "error", message: "Model returned no reply" },
        sessionId,
      );
    } else {
      await progress(tabId, sessionId, "Finished", "done");
    }
  } catch (err) {
    if (runtime.cancelled) {
      await progress(tabId, sessionId, "Stopped", "done");
      broadcast(tabId, { type: "stopped" }, sessionId);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      broadcast(tabId, { type: "error", message }, sessionId);
      await pushMessage(tabId, sessionId, {
        role: "system",
        content: message,
        ts: Date.now(),
      });
    }
  } finally {
    // Only unlock this chat. A delete/switch mid-run must not clear a new one.
    if (runtime.chatSessionId === sessionId) {
      runtime.busy = false;
      runtime.abort = null;
    }
    broadcast(tabId, { type: "done" }, sessionId);
    const queued = runtime.pendingRepair;
    if (queued && !runtime.cancelled) {
      runtime.pendingRepair = null;
      void maybeStartRepair(tabId, queued, true);
    }
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "RUNTIME_ERROR": {
        const tabId = sender.tab?.id ?? message.tabId;
        if (tabId == null) {
          sendResponse({ ok: false });
          break;
        }
        const tab = getTab(tabId);
        const sessionId = tab.chatSessionId;
        const text = message.message || "Scene runtime failed";
        if (isTransientHostError(text)) {
          sendResponse({ ok: true });
          break;
        }
        if (sessionId) {
          await sessions.setLastRuntimeError(sessionId, text);
          await progress(
            tabId,
            sessionId,
            message.fatal ? "Scene runtime stopped" : "Scene runtime error",
            "error",
            text,
          );
        }
        broadcast(
          tabId,
          { type: "error", message: text },
          sessionId,
        );
        sendResponse({ ok: true });
        void maybeStartRepair(tabId, text, Boolean(message.fatal));
        break;
      }
      case "CONTENT_READY": {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false });
          break;
        }
        const chat = await ensureChatForTab(tabId);
        if (!chat.lastPatch) {
          sendResponse({ ok: true, restored: false });
          break;
        }
        await waitForApply(tabId);
        const live = await pingTab(tabId);
        if (live?.runtimeLive) {
          getTab(tabId).hasPatch = true;
          sendResponse({ ok: true, restored: false });
          break;
        }
        const restored = await restoreLastPatch(tabId);
        sendResponse({ ok: true, restored });
        break;
      }
      case "INJECT_THREE_STAGE": {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no tab" });
          break;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["src/page/threeStage.js"],
            world: "MAIN",
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case "GET_SETTINGS": {
        const settings = await loadSettings();
        sendResponse({ type: "SETTINGS", settings } satisfies RuntimeMessage);
        break;
      }
      case "SAVE_SETTINGS": {
        await saveSettings(message.settings);
        sendResponse({
          type: "SETTINGS",
          settings: message.settings,
        } satisfies RuntimeMessage);
        break;
      }
      case "GET_TAB_STATE": {
        sendResponse(await buildTabState(message.tabId));
        break;
      }
      case "LIST_SESSIONS": {
        sendResponse({
          type: "SESSIONS",
          sessions: await sessions.listSessions(),
        } satisfies RuntimeMessage);
        break;
      }
      case "OPEN_SESSION": {
        const existing = await sessions.getSession(message.sessionId);
        if (!existing) {
          sendResponse({ error: "Session not found" });
          break;
        }
        const runtime = getTab(message.tabId);
        runtime.chatSessionId = existing.id;
        runtime.activity = existing.activity ?? [];
        // Rebind the same Cursor agent chat — do not mint a fresh sess_*.
        runtime.agentSession = {
          id: existing.id,
          tabId: message.tabId,
          kind: "persistent",
          pageUrl: existing.url,
          createdAt: existing.createdAt,
          cursorSessionId: existing.cursorSessionId,
        };
        if (existing.lastPatch) {
          runtime.hasPatch = true;
          void applyPatchToTab(message.tabId, existing.lastPatch);
        }
        sendResponse(await buildTabState(message.tabId));
        break;
      }
      case "NEW_SESSION": {
        const meta = await tabMeta(message.tabId);
        const created = await sessions.createSession({
          url: meta.url || "about:blank",
          pageTitle: meta.title,
        });
        const runtime = getTab(message.tabId);
        runtime.chatSessionId = created.id;
        runtime.activity = [];
        // New Monacle chat → new Cursor agent session (no --resume yet).
        runtime.agentSession = {
          id: created.id,
          tabId: message.tabId,
          kind: "persistent",
          pageUrl: created.url,
          createdAt: created.createdAt,
        };
        sendResponse(await buildTabState(message.tabId));
        break;
      }
      case "DELETE_SESSION": {
        await forgetSession(message.sessionId);
        await sessions.deleteSession(message.sessionId);
        sendResponse(await buildTabState(message.tabId));
        break;
      }
      case "PROMPT": {
        void handlePrompt(
          message.tabId,
          message.prompt,
          message.sessionId,
          message.images,
        );
        sendResponse({ ok: true });
        break;
      }
      case "STOP_PROMPT": {
        await handleStop(message.tabId, message.sessionId);
        sendResponse({ ok: true });
        break;
      }
      case "RESET": {
        const tabId = message.tabId ?? (await activeTabId());
        if (tabId != null) {
          await resetTab(tabId);
          const chat = await ensureChatForTab(tabId);
          await sessions.setLastPatch(chat.id, undefined);
          getTab(tabId).hasPatch = false;
          await pushMessage(tabId, chat.id, {
            role: "system",
            content: "Reset page scene.",
            ts: Date.now(),
          });
        }
        sendResponse({ type: "RESET_DONE" } satisfies RuntimeMessage);
        break;
      }
      case "OPEN_OPTIONS": {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
  })().catch((err) => {
    sendResponse({
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
});

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function stripModelNoise(text: string): string {
  const raw = (text || "").trim();
  if (!raw) return "";

  // Prefer message from a fenced or bare JSON object (final answer).
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        message?: string;
      };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // try next
    }
  }

  // No JSON message — drop fences and leftover payload braces.
  let out = raw.replace(/```[\s\S]*?```/g, "").trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const before = out.slice(0, start).trim();
    const after = out.slice(end + 1).trim();
    out = [before, after].filter(Boolean).join("\n").trim();
  }
  return out;
}

export type { Settings };
