import type {
  AgentEvent,
  AgentSession,
  PageContext,
  PromptImage,
} from "../shared/types";

export interface AgentProvider {
  readonly kind: "stateless" | "persistent";
  startSession(ctx: PageContext, tabId: number): Promise<AgentSession>;
  send(
    session: AgentSession,
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    pageContext: PageContext,
    images?: PromptImage[],
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
}
