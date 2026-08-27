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
import { validatePatch } from "../patches/schema";
import * as sessions from "./sessions";

/** Per-tab runtime cache — chat content lives in chrome.storage via sessions. */
interface TabRuntime {
  chatSessionId: string | null;
  agentSession: AgentSession | null;
  busy: boolean;
  hasPatch: boolean;
  lastContext: PageContext | null;
  activity: ActivityLine[];
}

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
    if (existing) return existing;
  }

  const meta = await tabMeta(tabId);
  if (meta.url) {
    const latest = await sessions.findLatestForUrl(meta.url);
    if (latest) {
      state.chatSessionId = latest.id;
      state.activity = latest.activity ?? [];
      return latest;
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
    hasPatch: state.hasPatch,
    activity: state.busy ? state.activity : chat.activity,
    pageUrl: meta.url,
    pageTitle: meta.title,
  };
}

async function getSnapshot(tabId: number): Promise<PageContext> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: "GET_SNAPSHOT",
    })) as RuntimeMessage;
    if (res?.type !== "SNAPSHOT") {
      throw new Error("Could not capture page snapshot");
    }
    return res.context;
  } catch {
    throw new Error(
      "Content script not ready. Refresh the tab, then try again.",
    );
  }
}

async function applyPatchToTab(tabId: number, patch: Patch): Promise<void> {
  const res = (await chrome.tabs.sendMessage(tabId, {
    type: "APPLY_PATCH",
    patch,
  })) as RuntimeMessage;
  if (res?.type === "PATCH_APPLIED" && !res.ok) {
    throw new Error(res.error || "Failed to apply patch");
  }
  getTab(tabId).hasPatch = true;
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

async function handlePrompt(
  tabId: number,
  prompt: string,
  sessionIdHint?: string,
  images?: PromptImage[],
): Promise<void> {
  const runtime = getTab(tabId);
  if (runtime.busy) return;
  runtime.busy = true;

  let chat: ChatSession | null = null;
  if (sessionIdHint) {
    chat = await sessions.getSession(sessionIdHint);
  }
  if (!chat) chat = await ensureChatForTab(tabId);
  runtime.chatSessionId = chat.id;
  const sessionId = chat.id;

  await pushMessage(tabId, sessionId, {
    role: "user",
    content: prompt,
    ts: Date.now(),
  });
  runtime.activity = [];
  await progress(tabId, sessionId, "Reading the page");

  try {
    const provider = await createProvider();
    const context = await getSnapshot(tabId);
    runtime.lastContext = context;
    await sessions.touchPageMeta(sessionId, context.url, context.title);
    await progress(
      tabId,
      sessionId,
      "Page snapshot",
      "done",
      `${context.title}\n${context.url}`,
    );

    if (!runtime.agentSession || runtime.agentSession.pageUrl !== context.url) {
      runtime.agentSession = await provider.startSession(context, tabId);
    }

    await progress(tabId, sessionId, "Asking Cursor");

    const fresh = await sessions.getSession(sessionId);
    const llmHistory = fresh?.history ?? [];

    let assistantText = "";
    let applied = false;

    for await (const event of provider.send(
      runtime.agentSession,
      prompt,
      llmHistory,
      context,
      images,
    )) {
      if (event.type === "text") {
        assistantText += event.text;
      } else if (event.type === "patch") {
        await progress(
          tabId,
          sessionId,
          event.patch.runtime ? "Applying scene" : "Applying restyle",
        );
        await applyPatchToTab(tabId, event.patch);
        applied = true;
        const note =
          event.patch.message ||
          (event.patch.runtime ? "Applied scene." : "Applied restyle.");
        broadcast(tabId, { type: "text", text: note }, sessionId);
        broadcast(tabId, event, sessionId);
        if (!assistantText.trim()) assistantText = note;
        else if (!assistantText.includes(note)) {
          assistantText = `${stripModelNoise(assistantText)}\n\n${note}`;
        } else {
          assistantText = stripModelNoise(assistantText);
        }
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
          await sessions.setActivity(sessionId, runtime.activity);
          broadcast(
            tabId,
            { type: "progress", line: { ...last }, update: true },
            sessionId,
          );
        } else {
          broadcast(tabId, event, sessionId);
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

    if (assistantText.trim()) {
      await pushMessage(tabId, sessionId, {
        role: "assistant",
        content: assistantText.trim(),
        ts: Date.now(),
      });
      const updated = await sessions.getSession(sessionId);
      if (updated) {
        updated.history.push({ role: "user", content: prompt });
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
        { type: "error", message: "Model returned no patch" },
        sessionId,
      );
    } else {
      await progress(tabId, sessionId, "Finished", "done");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast(tabId, { type: "error", message }, sessionId);
    await pushMessage(tabId, sessionId, {
      role: "system",
      content: message,
      ts: Date.now(),
    });
  } finally {
    // Clear busy before notifying the panel so GET_TAB_STATE / refreshState
    // cannot re-apply busy=true after the composer unlocked.
    runtime.busy = false;
    broadcast(tabId, { type: "done" }, sessionId);
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
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
        runtime.agentSession = null;
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
        runtime.agentSession = null;
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
      case "RESET": {
        const tabId = message.tabId ?? (await activeTabId());
        if (tabId != null) {
          await resetTab(tabId);
          const chat = await ensureChatForTab(tabId);
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
  let out = text.replace(/```[\s\S]*?```/g, "").trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const before = out.slice(0, start).trim();
    const after = out.slice(end + 1).trim();
    try {
      const parsed = JSON.parse(out.slice(start, end + 1)) as {
        message?: string;
      };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return [before, parsed.message.trim(), after]
          .filter(Boolean)
          .join("\n");
      }
    } catch {
      // keep prose
    }
    out = [before, after].filter(Boolean).join("\n").trim();
  }
  return out;
}

export type { Settings };
