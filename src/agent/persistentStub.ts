/** Placeholder for v2 — do not wire into the UI yet. */
import type {
  AgentEvent,
  AgentSession,
  PageContext,
} from "../shared/types";
import type { AgentProvider } from "./types";

/**
 * Future adapter for a persistent remote machine (Cursor Cloud Agents
 * `/v1/agents`, or the same /restyle contract as the local companion).
 * Side panel and background stay unchanged — swap this in via createProvider.
 */
export class PersistentCloudAgentProvider implements AgentProvider {
  readonly kind = "persistent" as const;

  async startSession(
    _ctx: PageContext,
    _tabId: number,
  ): Promise<AgentSession> {
    throw new Error("PersistentCloudAgentProvider is not implemented in v1");
  }

  async *send(
    _session: AgentSession,
    _prompt: string,
    _history: Array<{ role: "user" | "assistant"; content: string }>,
    _pageContext: PageContext,
    _images?: import("../shared/types").PromptImage[],
  ): AsyncIterable<AgentEvent> {
    throw new Error("PersistentCloudAgentProvider is not implemented in v1");
    yield { type: "done" };
  }
}
