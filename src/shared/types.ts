/** Shared message and domain types for Monacle. */

export type ProviderKind = "cursor-cli" | "anthropic" | "openai" | "xai";

export interface Settings {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string;
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
  id: string;
  tabId: number;
  kind: "stateless" | "persistent";
  pageUrl: string;
  createdAt: number;
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
  ts: number;
  state: "active" | "done" | "pending" | "error";
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "patch"; patch: Patch }
  | { type: "code"; code: string }
  | { type: "error"; message: string }
  | { type: "progress"; line: ActivityLine; update?: boolean }
  | { type: "done" };

export type RuntimeMessage =
  | { type: "GET_SNAPSHOT" }
  | { type: "SNAPSHOT"; context: PageContext }
  | { type: "APPLY_PATCH"; patch: Patch }
  | { type: "RESET"; tabId?: number }
  | { type: "PATCH_APPLIED"; ok: boolean; error?: string }
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
  | { type: "OPEN_OPTIONS" }
  | { type: "RUN_SANDBOX"; code: string; context: PageContext };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
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
