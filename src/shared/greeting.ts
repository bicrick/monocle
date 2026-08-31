/** Local assistant greeting for new / empty chats — never sent to the LLM. */
export const MONACLE_GREETING = "Hi. I am Monacle. How can I help you?";

export function greetingMessage(ts = Date.now()): {
  role: "assistant";
  content: string;
  ts: number;
} {
  return {
    role: "assistant",
    content: MONACLE_GREETING,
    ts,
  };
}
