import type {
  AgentEvent,
  AgentSession,
  PageContext,
  Settings,
} from "../shared/types";
import {
  extractCodeFromText,
  extractPatchFromText,
  patchFromRuntimeCode,
} from "../patches/schema";
import type { AgentProvider } from "./types";

function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class StatelessLlmProvider implements AgentProvider {
  readonly kind = "stateless" as const;

  constructor(
    private readonly settings: Settings,
    private readonly systemPrompt: string,
  ) {}

  async startSession(ctx: PageContext, tabId: number): Promise<AgentSession> {
    return {
      id: newSessionId(),
      tabId,
      kind: "stateless",
      pageUrl: ctx.url,
      createdAt: Date.now(),
    };
  }

  async *send(
    _session: AgentSession,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    pageContext: PageContext,
    _images?: import("../shared/types").PromptImage[],
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const contextBlock = [
      "PAGE CONTEXT (sanitized):",
      JSON.stringify(
        {
          url: pageContext.url,
          title: pageContext.title,
          viewport: pageContext.viewport,
          media: pageContext.media,
          landmarks: pageContext.landmarks,
        },
        null,
        2,
      ),
      "",
      "USER REQUEST:",
      prompt,
    ].join("\n");

    try {
      const text =
        this.settings.provider === "anthropic"
          ? await this.callAnthropic(history, contextBlock, signal)
          : await this.callOpenAiCompatible(history, contextBlock, signal);

      if (text.trim()) {
        yield { type: "text", text };
      }

      const patch = extractPatchFromText(text);
      if (patch) {
        yield { type: "patch", patch };
      } else {
        const code = extractCodeFromText(text);
        const runtimePatch = code ? patchFromRuntimeCode(code) : null;
        if (runtimePatch) yield { type: "patch", patch: runtimePatch };
      }

      yield { type: "done" };
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError") ||
        signal?.aborted
      ) {
        yield { type: "stopped" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message };
      yield { type: "done" };
    }
  }

  private async callAnthropic(
    history: Array<{ role: "user" | "assistant"; content: string }>,
    userContent: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const base = (this.settings.baseUrl || "https://api.anthropic.com").replace(
      /\/$/,
      "",
    );
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: userContent },
    ];

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal,
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (data.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }

  private async callOpenAiCompatible(
    history: Array<{ role: "user" | "assistant"; content: string }>,
    userContent: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const base = (
      this.settings.baseUrl ||
      (this.settings.provider === "xai"
        ? "https://api.x.ai/v1"
        : "https://api.openai.com/v1")
    ).replace(/\/$/, "");

    const messages = [
      { role: "system" as const, content: this.systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: userContent },
    ];

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        temperature: 0.4,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `${this.settings.provider} ${res.status}: ${body.slice(0, 400)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
