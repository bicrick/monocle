/**
 * React Bits Shiny Text, vanilla.
 * Create a new node when the phrase changes; never mutate one in place.
 */
export function createTextShimmer(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "shiny-text";
  el.textContent = text;
  return el;
}

export function isTextShimmer(node: Element | null): node is HTMLSpanElement {
  return !!node && node.classList.contains("shiny-text");
}
