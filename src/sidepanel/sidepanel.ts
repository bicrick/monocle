import type {
  AgentEvent,
  ChatMessage,
  PageContext,
  PromptImage,
  RuntimeMessage,
  SessionSummary,
} from "../shared/types";
import { validatePatch } from "../patches/schema";
import { createActivityBlock } from "./activity";
import {
  collectPasteImages,
  createAttachmentTray,
} from "./attachments";
import { createLogDrawer } from "./logDrawer";
import { createStatusChip } from "./statusChip";

const transcript = document.getElementById("transcript") as HTMLElement;
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const logsBtn = document.getElementById("logs-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const logHost = document.getElementById("log-host") as HTMLElement;
const newBtn = document.getElementById("new-btn") as HTMLButtonElement;
const historyEl = document.getElementById("history") as HTMLDetailsElement;
const historyCount = document.getElementById("history-count") as HTMLElement;
const historyList = document.getElementById("history-list") as HTMLElement;
const attachHost = document.getElementById("attach-host") as HTMLElement;
const connHost = document.getElementById("conn-host") as HTMLElement;
const sandboxFrame = document.getElementById(
  "sandbox-frame",
) as HTMLIFrameElement;

let tabId: number | null = null;
let sessionId: string | null = null;
let busy = false;
let draftAssistant: HTMLElement | null = null;

const activity = createActivityBlock();
const attachments = createAttachmentTray(attachHost);
const logs = createLogDrawer(logHost);
const connChip = createStatusChip(connHost, () => logs.toggle());

const sandboxPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let sandboxSeq = 0;

function setBusy(next: boolean): void {
  busy = next;
  sendBtn.disabled = next;
  promptEl.disabled = next;
  activity.setBusy(next);
  logs.setBusy(next);
}

function appendMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  el.textContent = msg.content;
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function renderMessages(messages: ChatMessage[]): void {
  transcript.innerHTML = "";
  draftAssistant = null;
  activity.clear();
  for (const m of messages) appendMessage(m);
}

function appendAssistantDelta(text: string): void {
  if (!text) return;
  if (!draftAssistant) {
    draftAssistant = document.createElement("div");
    draftAssistant.className = "msg assistant";
    transcript.appendChild(draftAssistant);
  }
  draftAssistant.textContent = (draftAssistant.textContent || "") + text;
  transcript.scrollTop = transcript.scrollHeight;
}

function ensureThoughtUnderChat(): void {
  activity.mountInto(transcript);
  transcript.scrollTop = transcript.scrollHeight;
}

function composerMaxPx(): number {
  return Math.min(Math.floor(window.innerHeight * 0.5), 480);
}

function autoGrow(): void {
  const maxPx = composerMaxPx();
  promptEl.style.maxHeight = `${maxPx}px`;
  // Collapse first so scrollHeight is content height, not the current box.
  promptEl.style.overflowY = "hidden";
  promptEl.style.height = "auto";
  const content = promptEl.scrollHeight;
  promptEl.style.height = `${Math.min(content, maxPx)}px`;
  promptEl.style.overflowY = content > maxPx ? "auto" : "hidden";
}

function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function closeHistory(): void {
  historyEl.open = false;
}

/** Titles that are blank shells or look like stored junk / URLs. */
function isBlankTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  return !t || /^new chat$/i.test(t) || /^untitled( chat)?$/i.test(t);
}

function isJunkTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (/^(chrome|moz|safari)-extension:/i.test(t)) return true;
  if (/^(data|blob):/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  // Mostly punctuation / ids with almost no readable words
  const readable = t.replace(/[^\p{L}\p{N}\s]+/gu, " ").trim();
  if (readable.length < 2) return true;
  return false;
}

function displaySessionTitle(s: SessionSummary): string {
  const raw = (s.title || "").replace(/\s+/g, " ").trim();
  if (raw && !isBlankTitle(raw) && !isJunkTitle(raw)) return raw;

  const page = (s.pageTitle || "").replace(/\s+/g, " ").trim();
  if (page && !isJunkTitle(page)) return page;

  if (s.host) return s.host;
  return "Untitled chat";
}

function isEmptyShell(s: SessionSummary): boolean {
  return isBlankTitle(s.title || "");
}

/** Hide unused "New chat" shells; keep active and any real turns. */
function visibleSessions(
  sessions: SessionSummary[],
  activeId: string | null,
): SessionSummary[] {
  const kept = sessions.filter(
    (s) => s.id === activeId || !isEmptyShell(s),
  );
  if (kept.length) return kept;
  if (activeId) {
    const active = sessions.find((s) => s.id === activeId);
    if (active) return [active];
  }
  return sessions.slice(0, 1);
}

function renderHistory(
  sessions: SessionSummary[],
  activeId: string | null,
): void {
  const visible = visibleSessions(sessions, activeId);
  historyCount.textContent = String(visible.length);
  historyList.replaceChildren();

  for (const s of visible) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item";
    if (s.id === activeId) btn.classList.add("is-active");
    btn.setAttribute("role", "listitem");
    btn.title = displaySessionTitle(s);

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = displaySessionTitle(s);

    const meta = document.createElement("span");
    meta.className = "history-item-meta";
    const host = (s.host || "").trim() || "page";
    meta.textContent = `${host} · ${relativeTime(s.updatedAt)}`;

    btn.append(title, meta);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeHistory();
      void openSession(s.id);
    });
    historyList.append(btn);
  }

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No chats yet";
    historyList.append(empty);
  }
}

async function resolveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function applyTabState(res: RuntimeMessage): void {
  if (res.type !== "TAB_STATE") return;
  sessionId = res.sessionId;
  renderMessages(res.messages);
  if (res.activity?.length) {
    ensureThoughtUnderChat();
    activity.setLines(res.activity);
  }
  setBusy(res.busy);
  if (res.busy) ensureThoughtUnderChat();
  renderHistory(res.sessions ?? [], res.sessionId);
}

async function refreshState(): Promise<void> {
  tabId = await resolveTabId();
  if (tabId == null) return;
  const res = (await chrome.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId,
  })) as RuntimeMessage;
  applyTabState(res);
}

async function openSession(id: string): Promise<void> {
  closeHistory();
  tabId = await resolveTabId();
  if (tabId == null) return;
  const res = (await chrome.runtime.sendMessage({
    type: "OPEN_SESSION",
    tabId,
    sessionId: id,
  })) as RuntimeMessage;
  applyTabState(res);
}

async function newSession(): Promise<void> {
  closeHistory();
  tabId = await resolveTabId();
  if (tabId == null) return;
  const res = (await chrome.runtime.sendMessage({
    type: "NEW_SESSION",
    tabId,
  })) as RuntimeMessage;
  applyTabState(res);
  promptEl.focus();
}

async function sendPrompt(): Promise<void> {
  const text = promptEl.value.trim();
  const pending = attachments.getImages();
  if ((!text && !pending.length) || busy) return;
  tabId = await resolveTabId();
  if (tabId == null) {
    appendMessage({
      role: "system",
      content: "No active tab.",
      ts: Date.now(),
    });
    return;
  }

  const display =
    text ||
    (pending.length
      ? `(${pending.length} image${pending.length > 1 ? "s" : ""})`
      : "");
  promptEl.value = "";
  autoGrow();
  appendMessage({ role: "user", content: display, ts: Date.now() });
  draftAssistant = null;
  activity.clear();
  ensureThoughtUnderChat();
  setBusy(true);
  activity.push({
    label: "Starting",
    ts: Date.now(),
    state: "active",
  });

  const images: PromptImage[] = pending.map((p) => ({
    name: p.name,
    mimeType: p.mimeType,
    dataBase64: p.dataBase64,
  }));
  attachments.clear();

  await chrome.runtime.sendMessage({
    type: "PROMPT",
    tabId,
    prompt: text || "Restyle based on the attached image(s).",
    sessionId: sessionId ?? undefined,
    images: images.length ? images : undefined,
  } satisfies RuntimeMessage);
}

async function resetPage(): Promise<void> {
  tabId = await resolveTabId();
  if (tabId == null) return;
  await chrome.runtime.sendMessage({
    type: "RESET",
    tabId,
  } satisfies RuntimeMessage);
  appendMessage({
    role: "system",
    content: "Reset page scene.",
    ts: Date.now(),
  });
}

function runSandbox(code: string, context: PageContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++sandboxSeq;
    const timer = setTimeout(() => {
      sandboxPending.delete(id);
      reject(new Error("Sandbox timed out"));
    }, 8000);

    sandboxPending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    const win = sandboxFrame.contentWindow;
    if (!win) {
      clearTimeout(timer);
      sandboxPending.delete(id);
      reject(new Error("Sandbox frame not ready"));
      return;
    }

    win.postMessage(
      {
        source: "monacle-host",
        type: "monacle-run",
        id,
        code,
        context,
      },
      "*",
    );
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "monacle-sandbox") return;
  if (data.type !== "monacle-patch-result") return;
  const waiter = sandboxPending.get(data.id as number);
  if (!waiter) return;
  sandboxPending.delete(data.id as number);
  if (data.error) waiter.reject(new Error(String(data.error)));
  else waiter.resolve(data.patch);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_SANDBOX") {
    runSandbox(message.code as string, message.context as PageContext)
      .then((patch) => {
        sendResponse({ patch: validatePatch(patch) });
      })
      .catch((err: Error) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (message?.type === "AGENT_EVENT") {
    const event = message.event as AgentEvent;
    const eventTab = message.tabId as number | undefined;
    const eventSession = message.sessionId as string | undefined;
    if (tabId != null && eventTab != null && eventTab !== tabId) return;
    if (
      sessionId != null &&
      eventSession != null &&
      eventSession !== sessionId
    ) {
      return;
    }

    if (event.type === "progress") {
      ensureThoughtUnderChat();
      if (event.update) activity.updateLast(event.line);
      else activity.push(event.line);
      activity.setBusy(event.line.state === "active");
    } else if (event.type === "text") {
      if (event.text) appendAssistantDelta(event.text);
    } else if (event.type === "error") {
      ensureThoughtUnderChat();
      activity.push({
        label: "Failed",
        detail: event.message,
        ts: Date.now(),
        state: "error",
      });
      appendMessage({
        role: "system",
        content: event.message,
        ts: Date.now(),
      });
    } else if (event.type === "done") {
      setBusy(false);
      draftAssistant = null;
      void refreshState();
    } else if (event.type === "patch") {
      ensureThoughtUnderChat();
      activity.push({
        label: "Applied scene",
        detail: event.patch.runtime ? "live runtime" : undefined,
        ts: Date.now(),
        state: "done",
      });
    }
  }
  return false;
});

promptEl.addEventListener("input", autoGrow);
promptEl.addEventListener("change", autoGrow);
window.addEventListener("resize", autoGrow);
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
  }
});
promptEl.addEventListener("paste", (e) => {
  void (async () => {
    const files = await collectPasteImages(e);
    if (!files.length) {
      // Text paste updates value after this handler; grow on the next turns.
      requestAnimationFrame(() => autoGrow());
      window.setTimeout(autoGrow, 0);
      return;
    }
    e.preventDefault();
    await attachments.addFiles(files);
  })();
});
autoGrow();
sendBtn.addEventListener("click", () => void sendPrompt());
resetBtn.addEventListener("click", () => void resetPage());
logsBtn.addEventListener("click", () => logs.toggle());
settingsBtn.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
});
newBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void newSession();
});

const companionBase = "http://127.0.0.1:8787";
logs.start(companionBase);
connChip.start(companionBase);
void refreshState();
chrome.tabs.onActivated.addListener(() => void refreshState());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && (info.status === "complete" || info.url)) {
    void refreshState();
  }
});
