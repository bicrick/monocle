import type { ChatMessage, PromptImage } from "../shared/types";

export function imageDataUrl(img: PromptImage): string {
  const mime = img.mimeType || "image/png";
  return `data:${mime};base64,${img.dataBase64}`;
}

/** Render a turn into an existing `.msg` node (thumbs live inside the bubble). */
export function renderChatMessage(el: HTMLElement, msg: ChatMessage): void {
  el.className = `msg ${msg.role}`;
  el.replaceChildren();

  if (msg.role === "assistant") {
    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = "Monacle";
    el.append(label);
  }

  if (msg.images?.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "msg-thumbs";
    for (const img of msg.images) {
      const thumb = document.createElement("img");
      thumb.className = "msg-thumb";
      thumb.src = imageDataUrl(img);
      thumb.alt = img.name || "attachment";
      thumbs.append(thumb);
    }
    el.append(thumbs);
  }

  if (msg.content) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = msg.content;
    el.append(text);
  }
}

export function createChatMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement("div");
  renderChatMessage(el, msg);
  return el;
}

/** Empty assistant shell used while streaming deltas. */
export function createAssistantDraft(): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = "Monacle";
  const text = document.createElement("div");
  text.className = "msg-text";
  el.append(label, text);
  return el;
}
