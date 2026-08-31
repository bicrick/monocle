import type {
  AgentEvent,
  ChatMessage,
  PageContext,
  PromptImage,
  RuntimeMessage,
} from "../shared/types";
import { validatePatch } from "../patches/schema";
import { createActivityBlock } from "./activity";
import {
  collectPasteImages,
  createAttachmentTray,
} from "./attachments";
import { createAssistantDraft, createChatMessage } from "./chatMessage";
import { createHistoryPanel } from "./historyPanel";
import { createLogDrawer } from "./logDrawer";
import { createModelPicker } from "./modelPicker";
import { isOpenableUrl } from "./sessionTitle";
import { startTheme } from "../shared/theme";

startTheme();

const transcript = document.getElementById("transcript") as HTMLElement;
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const logsBtn = document.getElementById("logs-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const logHost = document.getElementById("log-host") as HTMLElement;
const newBtn = document.getElementById("new-btn") as HTMLButtonElement;
const historyToggle = document.getElementById(
  "history-toggle",
) as HTMLButtonElement;
const historyPanelEl = document.getElementById("history-panel") as HTMLElement;
const historyCount = document.getElementById("history-count") as HTMLElement;
const historyList = document.getElementById("history-list") as HTMLElement;
const chatTitle = document.getElementById("chat-title") as HTMLButtonElement;
const chatStage = document.getElementById("chat-stage") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const attachHost = document.getElementById("attach-host") as HTMLElement;
const connHost = document.getElementById("conn-host") as HTMLElement;
const sandboxFrame = document.getElementById(
  "sandbox-frame",
) as HTMLIFrameElement;

const TRANSCRIPT_SCROLL_SLACK = 48;
let transcriptStickBottom = true;

transcript.addEventListener("scroll", () => {
  transcriptStickBottom =
    transcript.scrollTop + transcript.clientHeight >=
    transcript.scrollHeight - TRANSCRIPT_SCROLL_SLACK;
});

function scrollTranscriptToBottom(force = false): void {
  if (!force && !transcriptStickBottom) return;
  transcript.scrollTop = transcript.scrollHeight;
  transcriptStickBottom = true;
}

let tabId: number | null = null;
let sessionId: string | null = null;
let busy = false;
let draftAssistant: HTMLElement | null = null;

const activity = createActivityBlock();
const attachments = createAttachmentTray(attachHost);
const logs = createLogDrawer(logHost);
const modelPicker = createModelPicker(connHost);

const sandboxPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let sandboxSeq = 0;

function setBusy(next: boolean): void {
  busy = next;
  sendBtn.disabled = false;
  sendBtn.classList.toggle("is-stop", next);
  sendBtn.title = next ? "Stop" : "Send";
  sendBtn.setAttribute("aria-label", next ? "Stop" : "Send");
  promptEl.disabled = false;
  activity.setBusy(next);
  logs.setBusy(next);
}

function appendMessage(msg: ChatMessage): HTMLElement {
  const el = createChatMessage(msg);
  transcript.appendChild(el);
  scrollTranscriptToBottom(true);
  return el;
}

function renderMessages(messages: ChatMessage[]): void {
  transcript.innerHTML = "";
  draftAssistant = null;
  activity.clear();
  for (const m of messages) appendMessage(m);
  scrollTranscriptToBottom(true);
}

function appendAssistantDelta(text: string): void {
  if (!text) return;
  if (!draftAssistant) {
    draftAssistant = createAssistantDraft();
    transcript.appendChild(draftAssistant);
  }
  const body =
    draftAssistant.querySelector(".msg-text") ?? draftAssistant;
  body.textContent = (body.textContent || "") + text;
  scrollTranscriptToBottom();
}

function ensureThoughtUnderChat(): void {
  activity.mountInto(transcript);
  scrollTranscriptToBottom();
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

async function openSessionPage(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  tabId = tabId ?? (await resolveTabId());
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { url });
      return;
    } catch {
      /* fall through to a new tab */
    }
  }
  await chrome.tabs.create({ url });
}

const history = createHistoryPanel({
  app: appEl,
  toggle: historyToggle,
  panel: historyPanelEl,
  list: historyList,
  count: historyCount,
  titleBtn: chatTitle,
  stage: chatStage,
  onSelect: (id) => {
    void openSession(id);
  },
  onOpenPage: (url) => {
    void openSessionPage(url);
  },
});

async function resolveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function applyTabState(res: RuntimeMessage): void {
  if (res.type !== "TAB_STATE") return;
  sessionId = res.sessionId;
  renderMessages(res.messages);
  setBusy(res.busy);
  if (res.activity?.length) {
    ensureThoughtUnderChat();
    activity.setLines(res.activity);
  } else if (res.busy) {
    ensureThoughtUnderChat();
  }
  history.render(res.sessions ?? [], res.sessionId);
}

async function refreshState(): Promise<void> {
  try {
    tabId = await resolveTabId();
  } catch {
    tabId = null;
  }
  if (tabId == null) {
    history.render([], null);
    return;
  }
  const res = (await chrome.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId,
  })) as RuntimeMessage;
  applyTabState(res);
}

async function openSession(id: string): Promise<void> {
  history.close();
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
  history.close();
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

  const images: PromptImage[] = pending.map((p) => ({
    name: p.name,
    mimeType: p.mimeType,
    dataBase64: p.dataBase64,
  }));
  promptEl.value = "";
  autoGrow();
  appendMessage({
    role: "user",
    content: text,
    ts: Date.now(),
    images: images.length ? images : undefined,
  });
  draftAssistant = null;
  activity.clear();
  ensureThoughtUnderChat();
  setBusy(true);
  activity.push({
    label: "Starting",
    ts: Date.now(),
    state: "active",
  });
  attachments.clear();

  await chrome.runtime.sendMessage({
    type: "PROMPT",
    tabId,
    prompt: text || "Restyle based on the attached image(s).",
    sessionId: sessionId ?? undefined,
    images: images.length ? images : undefined,
  } satisfies RuntimeMessage);
}

async function stopPrompt(): Promise<void> {
  if (!busy) return;
  tabId = tabId ?? (await resolveTabId());
  if (tabId == null) return;
  await chrome.runtime.sendMessage({
    type: "STOP_PROMPT",
    tabId,
    sessionId: sessionId ?? undefined,
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
    } else if (event.type === "stopped") {
      ensureThoughtUnderChat();
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
    if (busy) return;
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
sendBtn.addEventListener("click", () => {
  if (busy) void stopPrompt();
  else void sendPrompt();
});
resetBtn.addEventListener("click", () => void resetPage());
logsBtn.addEventListener("click", () => {
  logs.toggle();
  logsBtn.setAttribute("aria-expanded", logs.isOpen() ? "true" : "false");
});
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
modelPicker.start(companionBase);
void refreshState();
chrome.tabs.onActivated.addListener(() => void refreshState());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && (info.status === "complete" || info.url)) {
    void refreshState();
  }
});
