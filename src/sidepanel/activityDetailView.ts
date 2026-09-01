import {
  parseActivityDetail,
  type ActivityField,
} from "./activityDetail";

const MAX_FIELD_CHARS = 20_000;
const SCROLL_SLACK = 16;

const EDIT_KEYS = new Set(["css", "overlayHtml", "runtime", "ops", "edit"]);

function isPinnedToBottom(el: HTMLElement, slack = SCROLL_SLACK): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}

function pinIfNeeded(el: HTMLElement, stick: boolean): void {
  if (!stick) return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

/** Remember whether the user is following the stream in this pane. */
function guardScrollStick(el: HTMLElement): void {
  if (el.dataset.scrollGuard === "1") return;
  el.dataset.scrollGuard = "1";
  el.dataset.stickBottom = "1";
  el.addEventListener("scroll", () => {
    el.dataset.stickBottom = isPinnedToBottom(el) ? "1" : "0";
  });
}

function shouldStick(el: HTMLElement): boolean {
  // Default stick until the user scrolls away from the bottom.
  return el.dataset.stickBottom !== "0";
}

function clipFieldValue(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}\n…`
    : value;
}

/**
 * Update activity detail in place so nested OUTPUT panes keep scroll position.
 * Only auto-scroll a pane when the reader was already pinned to the bottom.
 */
export function renderActivityDetail(host: HTMLElement, raw: string): void {
  const parsed = parseActivityDetail(raw);
  guardScrollStick(host);

  if (parsed.fallback != null) {
    const stick = shouldStick(host) && isPinnedToBottom(host);
    host.classList.remove("activity-detail");
    if (host.textContent !== parsed.fallback) {
      host.replaceChildren();
      host.textContent = parsed.fallback;
    }
    pinIfNeeded(host, stick);
    return;
  }

  host.classList.add("activity-detail");
  const hostStick = shouldStick(host) && isPinnedToBottom(host);

  syncThinking(host, parsed.thinking);
  syncSteps(host, parsed.steps);
  syncFields(host, parsed.fields);

  pinIfNeeded(host, hostStick);
}

function syncThinking(host: HTMLElement, thinking: string | null): void {
  let thought = host.querySelector(
    ":scope > .activity-detail-thinking",
  ) as HTMLElement | null;
  if (!thinking) {
    thought?.remove();
    return;
  }
  if (!thought) {
    thought = document.createElement("p");
    thought.className = "activity-detail-thinking";
    host.prepend(thought);
  }
  if (thought.textContent !== thinking) thought.textContent = thinking;
}

function syncSteps(host: HTMLElement, steps: string[]): void {
  let list = host.querySelector(
    ":scope > .activity-detail-steps",
  ) as HTMLUListElement | null;
  if (!steps.length) {
    list?.remove();
    return;
  }
  if (!list) {
    list = document.createElement("ul");
    list.className = "activity-detail-steps";
    const after = host.querySelector(":scope > .activity-detail-thinking");
    if (after?.nextSibling) host.insertBefore(list, after.nextSibling);
    else if (after) after.after(list);
    else host.prepend(list);
  }
  const items = Array.from(list.children) as HTMLLIElement[];
  for (let i = 0; i < steps.length; i++) {
    let item = items[i];
    if (!item) {
      item = document.createElement("li");
      item.className = "activity-detail-step";
      list.append(item);
    }
    if (item.textContent !== steps[i]) item.textContent = steps[i];
  }
  for (let i = steps.length; i < items.length; i++) items[i]?.remove();
}

function syncFields(host: HTMLElement, fields: ActivityField[]): void {
  const wanted = new Set(fields.map((f) => f.key));
  for (const el of Array.from(
    host.querySelectorAll(
      ":scope > .activity-detail-block, :scope > .activity-detail-edit",
    ),
  )) {
    const key = (el as HTMLElement).dataset.field;
    if (!key || !wanted.has(key)) el.remove();
  }
  for (const field of fields) upsertField(host, field);
}

function upsertField(host: HTMLElement, field: ActivityField): void {
  const value = clipFieldValue(field.value);
  const existing = host.querySelector(
    `:scope > [data-field="${CSS.escape(field.key)}"]`,
  ) as HTMLElement | null;

  if (EDIT_KEYS.has(field.key)) {
    let wrap = existing;
    if (!wrap || !wrap.classList.contains("activity-detail-edit")) {
      wrap?.remove();
      wrap = document.createElement("details");
      wrap.className = "activity-detail-edit";
      wrap.dataset.field = field.key;
      const summary = document.createElement("summary");
      summary.className = "activity-detail-edit-summary";
      summary.textContent =
        field.key === "runtime" ? "Editing scene" : field.label;
      const code = document.createElement("pre");
      code.className = `activity-detail-code is-${field.lang}`;
      wrap.append(summary, code);
      host.append(wrap);
    }
    setCodeText(wrap.querySelector(".activity-detail-code") as HTMLElement, value);
    return;
  }

  let block = existing;
  if (!block || !block.classList.contains("activity-detail-block")) {
    block?.remove();
    block = document.createElement("section");
    block.className = "activity-detail-block";
    block.dataset.field = field.key;
    const label = document.createElement("div");
    label.className = "activity-detail-label";
    label.textContent = field.label;
    const code = document.createElement("pre");
    code.className = `activity-detail-code is-${field.lang}`;
    block.append(label, code);
    host.append(block);
  } else {
    const label = block.querySelector(".activity-detail-label");
    if (label && label.textContent !== field.label) {
      label.textContent = field.label;
    }
  }

  setCodeText(block.querySelector(".activity-detail-code") as HTMLElement, value);
}

function setCodeText(code: HTMLElement, value: string): void {
  guardScrollStick(code);
  const stick = shouldStick(code) && isPinnedToBottom(code);
  if (code.textContent !== value) code.textContent = value;
  pinIfNeeded(code, stick);
}
