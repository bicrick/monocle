import {
  formatExpandDetail,
  interpretStatus,
} from "../shared/activityTalk";
import type {
  AgentEvent,
  AgentSession,
  PageContext,
  PageRead,
  PromptImage,
  Settings,
} from "../shared/types";
import {
  extractCodeFromText,
  extractPatchFromText,
  patchFromRuntimeCode,
} from "../patches/schema";
import {
  navigateTab,
  sendPageRead,
} from "../background/contentBridge";
import type { AgentProvider } from "./types";

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  label?: string;
}

/** Talks to the local Monacle companion, which runs Cursor CLI on this machine. */
export class CursorCliProvider implements AgentProvider {
  /** One continuous Cursor CLI chat per Monacle chat (`--resume`). */
  readonly kind = "persistent" as const;

  constructor(
    private readonly settings: Settings,
    private readonly systemPrompt: string,
  ) {}

  async startSession(ctx: PageContext, tabId: number): Promise<AgentSession> {
    // Background should prefer binding to ChatSession.id; this is a fallback.
    return {
      id: `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      tabId,
      kind: "persistent",
      pageUrl: ctx.url,
      createdAt: Date.now(),
    };
  }

  async *send(
    session: AgentSession,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    pageContext: PageContext,
    images?: PromptImage[],
    pageRead?: PageRead,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const base = (this.settings.baseUrl || "http://127.0.0.1:8787").replace(
      /\/$/,
      "",
    );
    const originUrl = pageContext.url || session.pageUrl || "";
    const fulfilled = new Set<string>();

    try {
      const restyle = fetch(`${base}/restyle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          // Companion concurrency key = Monacle chat id
          sessionId: session.id,
          source: "sidepanel",
          systemPrompt: this.systemPrompt,
          prompt,
          history,
          context: pageContext,
          resumeId: session.cursorSessionId || undefined,
          cursorSessionId: session.cursorSessionId || undefined,
          images: images?.map((img) => ({
            name: img.name,
            mimeType: img.mimeType,
            dataBase64: img.dataBase64,
          })),
          model:
            this.settings.model && this.settings.model !== "auto"
              ? this.settings.model
              : undefined,
        }),
      });

      let finished = false;
      const done = restyle.finally(() => {
        finished = true;
      });

      let lastVerb = "Thinking";
      yield {
        type: "progress",
        update: true,
        line: {
          label: lastVerb,
          detail: "waiting…",
          ts: Date.now(),
          state: "active",
        },
      };

      while (!finished) {
        if (signal?.aborted) break;
        const raced = await Promise.race([
          done.then(() => "done" as const),
          sleep(400).then(() => "tick" as const),
        ]);
        if (raced !== "tick") break;

        const status = await readCliStatusRaw(base, session.id);
        if (status?.pendingTool && !fulfilled.has(status.pendingTool.id)) {
          const tool = status.pendingTool;
          fulfilled.add(tool.id);
          const label = tool.label || toolVerb(tool.name);
          yield {
            type: "progress",
            line: {
              label,
              detail: tool.name === "navigate"
                ? String(tool.args?.url || "")
                : undefined,
              ts: Date.now(),
              state: "active",
            },
          };
          try {
            const result = await fulfillTabTool(
              session.tabId,
              tool,
              originUrl,
            );
            await postToolResult(base, session.id, tool.id, result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await postToolResult(base, session.id, tool.id, null, message);
            yield {
              type: "progress",
              line: {
                label: label,
                detail: message,
                ts: Date.now(),
                state: "error",
              },
            };
          }
          continue;
        }

        const talk = status ? interpretStatus(status) : null;
        if (talk) {
          const verb = talk.verb || "Thinking";
          const sameVerb = verb === lastVerb;
          lastVerb = verb;
          yield {
            type: "progress",
            update: sameVerb,
            line: {
              label: verb,
              thinking: talk.thinking || undefined,
              detail: formatExpandDetail(talk),
              ts: Date.now(),
              state: "active",
            },
          };
        }
      }

      if (signal?.aborted) {
        yield { type: "stopped" };
        return;
      }

      const res = await restyle;

      if (!res.ok) {
        const body = await res.text();
        let parsed: { error?: string; logs?: string; logPath?: string } | null =
          null;
        try {
          parsed = JSON.parse(body) as {
            error?: string;
            logs?: string;
            logPath?: string;
          };
        } catch {
          parsed = null;
        }
        const head = parsed?.error || body.slice(0, 400);
        const tail = parsed?.logs ? `\n\n${parsed.logs}` : "";
        const busy =
          res.status === 429 || res.status === 409
            ? " Another agent is using this companion — retry in a moment."
            : "";
        throw new Error(
          `Local Cursor companion ${res.status}: ${head}${tail}${busy}`,
        );
      }

      const data = (await res.json()) as {
        text?: string;
        error?: string;
        cursorSessionId?: string;
      };
      if (data.error) throw new Error(data.error);

      if (
        typeof data.cursorSessionId === "string" &&
        data.cursorSessionId.trim()
      ) {
        yield {
          type: "cursor_session",
          cursorSessionId: data.cursorSessionId.trim(),
        };
      }

      const text = data.text ?? "";
      if (text.trim()) yield { type: "text", text };

      const patch = extractPatchFromText(text);
      if (patch) yield { type: "patch", patch };
      else {
        const code = extractCodeFromText(text);
        const runtimePatch = code ? patchFromRuntimeCode(code) : null;
        if (runtimePatch) yield { type: "patch", patch: runtimePatch };
      }

      yield { type: "done" };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        yield { type: "stopped" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const hint = /fetch|Failed|ECONNREFUSED|NetworkError/i.test(message)
        ? "Start the local stack: npm run dev — then agent login if prompted."
        : message;
      yield { type: "error", message: hint };
      yield { type: "done" };
    }
  }
}

function toolVerb(name: string): string {
  if (name === "read_page") return "Reading page";
  if (name === "list_links") return "Listing links";
  if (name === "navigate") return "Navigating";
  return `Tool ${name}`;
}

async function fulfillTabTool(
  tabId: number,
  tool: PendingToolCall,
  originUrl: string,
): Promise<PageRead | { links: PageRead["links"]; url: string; title: string }> {
  if (tool.name === "read_page") {
    return sendPageRead(tabId);
  }
  if (tool.name === "list_links") {
    const page = await sendPageRead(tabId);
    return { url: page.url, title: page.title, links: page.links };
  }
  if (tool.name === "navigate") {
    const target = String(tool.args?.url || "");
    if (!target.trim()) throw new Error("navigate requires url");
    return navigateTab(tabId, target, originUrl);
  }
  throw new Error(`Unknown tab tool: ${tool.name}`);
}

async function postToolResult(
  base: string,
  sessionId: string,
  toolId: string,
  result: unknown,
  error?: string,
): Promise<void> {
  try {
    await fetch(`${base}/tool-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        error
          ? { sessionId, toolId, error }
          : { sessionId, toolId, result },
      ),
    });
  } catch {
    // companion may have ended
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCliStatusRaw(
  base: string,
  sessionId?: string,
): Promise<{
  running?: boolean;
  summary?: string;
  model?: string | null;
  thinking?: string;
  hasPayload?: boolean;
  payload?: string;
  lines?: string[];
  raw?: string[];
  pendingTool?: PendingToolCall | null;
  originUrl?: string | null;
} | null> {
  try {
    const qs = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`${base}/status${qs}`);
    if (!res.ok) return null;
    return (await res.json()) as {
      running?: boolean;
      summary?: string;
      model?: string | null;
      thinking?: string;
      hasPayload?: boolean;
      payload?: string;
      lines?: string[];
      raw?: string[];
      pendingTool?: PendingToolCall | null;
      originUrl?: string | null;
    };
  } catch {
    return null;
  }
}
