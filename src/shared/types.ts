/** Shared message and domain types for Monacle. */

export type ProviderKind = "cursor-cli" | "anthropic" | "openai" | "xai";

export type ThemeKind = "system" | "light" | "dark";

export interface Settings {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string;
  theme?: ThemeKind;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LandmarkNode {
  tag: string;
  id?: string;
  classes?: string[];
  role?: string;
  text?: string;
  rect?: Rect;
  children?: LandmarkNode[];
}

export interface MediaInfo {
  tag: "video" | "audio";
  selector: string;
  rect: Rect;
  paused?: boolean;
  currentTime?: number;
  duration?: number;
}

export interface PageContext {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  landmarks: LandmarkNode[];
  media: MediaInfo[];
  capturedAt: number;
  lastRuntimeError?: string;
}

/** Readable extract for agent explore tools (full text, not landmark snippets). */
export interface PageLink {
  href: string;
  text: string;
}

export interface PageRead {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
  capturedAt: number;
}

export type PatchOpType =
  | "hide"
  | "show"
  | "wrap"
  | "move"
  | "restyle"
  | "insert"
  | "remove";

export type InsertPosition = "before" | "after" | "prepend" | "append";

export interface PatchOp {
  type: PatchOpType;
  selector: string;
  css?: Record<string, string>;
  wrapTag?: string;
  wrapClass?: string;
  targetSelector?: string;
  /** HTML to insert (insert op). Marked with data-monacle-insert. */
  html?: string;
  position?: InsertPosition;
}

export interface Patch {
  css?: string;
  overlayHtml?: string;
  ops?: PatchOp[];
  /** Live isolated-world JS using the monacle.* host API. */
  runtime?: string;
  message?: string;
}

export interface AgentSession {
  /** Monacle chat id (`chat_*`) — one agent conversation per chat. */
  id: string;
  tabId: number;
  kind: "stateless" | "persistent";
  pageUrl: string;
  createdAt: number;
  /** Cursor CLI session UUID for `agent --resume`. */
  cursorSessionId?: string;
}

export interface PromptImage {
  name: string;
  mimeType: string;
  /** Raw base64 without data: prefix */
  dataBase64: string;
}

export interface ActivityLine {
  label: string;
  detail?: string;
  /** Latest streamed thought — never payload. */
  thinking?: string;
  ts: number;
  state: "active" | "done" | "pending" | "error";
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "patch"; patch: Patch }
  | { type: "code"; code: string }
  | { type: "error"; message: string }
  | { type: "progress"; line: ActivityLine; update?: boolean }
  | { type: "cursor_session"; cursorSessionId: string }
  | { type: "stopped" }
  | { type: "done" };

export type RuntimeMessage =
  | { type: "GET_SNAPSHOT" }
  | { type: "SNAPSHOT"; context: PageContext }
  | { type: "GET_PAGE_READ" }
  | { type: "PAGE_READ"; page: PageRead }
  | { type: "APPLY_PATCH"; patch: Patch }
  | { type: "RESET"; tabId?: number }
  | {
      type: "PATCH_APPLIED";
      ok: boolean;
      error?: string;
      opErrors?: string[];
      runtimeStarted?: boolean;
    }
  | { type: "RUNTIME_ERROR"; message: string; fatal?: boolean; tabId?: number }
  | { type: "RESET_DONE" }
  | {
      type: "PROMPT";
      tabId: number;
      prompt: string;
      sessionId?: string;
      images?: PromptImage[];
    }
  | { type: "AGENT_EVENT"; tabId?: number; sessionId?: string; event: AgentEvent }
  | { type: "GET_SETTINGS" }
  | { type: "SETTINGS"; settings: Settings }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "GET_TAB_STATE"; tabId: number }
  | {
      type: "TAB_STATE";
      tabId: number;
      sessionId: string | null;
      sessions: SessionSummary[];
      messages: ChatMessage[];
      busy: boolean;
      hasPatch: boolean;
      activity: ActivityLine[];
      pageUrl?: string;
      pageTitle?: string;
    }
  | { type: "LIST_SESSIONS" }
  | { type: "SESSIONS"; sessions: SessionSummary[] }
  | { type: "OPEN_SESSION"; tabId: number; sessionId: string }
  | { type: "NEW_SESSION"; tabId: number }
  | { type: "DELETE_SESSION"; tabId: number; sessionId: string }
  | { type: "STOP_PROMPT"; tabId: number; sessionId?: string }
  | { type: "OPEN_OPTIONS" }
  | { type: "RUN_SANDBOX"; code: string; context: PageContext }
  | { type: "INJECT_THREE_STAGE" }
  | { type: "CONTENT_READY"; hasPatch?: boolean; runtimeLive?: boolean }
  | { type: "PING" };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  /** Pasted / shipped images — shown as thumbs in the same user bubble. */
  images?: PromptImage[];
}

/** Persisted restyle chat — survives panel close and service worker sleep. */
export interface ChatSession {
  id: string;
  title: string;
  pageTitle: string;
  url: string;
  /** URL without hash — used to resume when reopening a page. */
  urlKey: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  activity: ActivityLine[];
  /** Last sandbox/runtime failure — included on the next restyle turn. */
  lastRuntimeError?: string;
  /** Last applied scene — restored after HMR, tab refresh, or content-script death. */
  lastPatch?: Patch;
  /** Cursor CLI chat UUID — successive prompts in this chat use --resume. */
  cursorSessionId?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  pageTitle: string;
  url: string;
  urlKey: string;
  updatedAt: number;
  host: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "cursor-cli",
  apiKey: "",
  model: "auto",
  baseUrl: "http://127.0.0.1:8787",
  theme: "system",
};

export const MODEL_DEFAULTS: Record<ProviderKind, string> = {
  "cursor-cli": "auto",
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  xai: "grok-4.6",
};

export const BASE_URL_DEFAULTS: Record<ProviderKind, string> = {
  "cursor-cli": "http://127.0.0.1:8787",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
};
