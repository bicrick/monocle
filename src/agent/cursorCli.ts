import type {
  AgentEvent,
  AgentSession,
  PageContext,
  PromptImage,
  Settings,
} from "../shared/types";
import {
  extractCodeFromText,
  extractPatchFromText,
  patchFromRuntimeCode,
} from "../patches/schema";
import type { AgentProvider } from "./types";

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
  ): AsyncIterable<AgentEvent> {
    const base = (this.settings.baseUrl || "http://127.0.0.1:8787").replace(
      /\/$/,
      "",
    );

    try {
      const restyle = fetch(`${base}/restyle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

      yield {
        type: "progress",
        update: true,
        line: {
          label: session.cursorSessionId
            ? "Continuing chat"
            : "Asking Cursor",
          detail: "waiting… 1s",
          ts: Date.now(),
          state: "active",
        },
      };

      while (!finished) {
        const raced = await Promise.race([
          done.then(() => "done" as const),
          sleep(600).then(() => "tick" as const),
        ]);
        if (raced !== "tick") break;
        const detail = await readCliStatus(base, session.id);
        if (detail) {
          yield {
            type: "progress",
            update: true,
            line: {
              label: session.cursorSessionId
                ? "Continuing chat"
                : "Asking Cursor",
              detail,
              ts: Date.now(),
              state: "active",
            },
          };
        }
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
      const message = err instanceof Error ? err.message : String(err);
      const hint = /fetch|Failed|ECONNREFUSED|NetworkError/i.test(message)
        ? "Start the local stack: npm run dev — then agent login if prompted."
        : message;
      yield { type: "error", message: hint };
      yield { type: "done" };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCliStatus(
  base: string,
  sessionId?: string,
): Promise<string> {
  try {
    const qs = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`${base}/status${qs}`);
    if (!res.ok) return "";
    const data = (await res.json()) as {
      running?: boolean;
      summary?: string;
      model?: string | null;
      lines?: string[];
      raw?: string[];
    };
    const steps = data.lines?.length ? data.lines : data.raw ?? [];
    if (!data.running && !steps.length) return "";
    const parts: string[] = [];
    if (data.summary) parts.push(data.summary);
    const excerpt = steps.slice(-30);
    if (excerpt.length) parts.push(excerpt.join("\n"));
    return parts.join("\n");
  } catch {
    return "";
  }
}
