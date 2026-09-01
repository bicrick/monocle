import {
  interpretActivityLine,
  isGenericActivityLabel,
  isPayloadText,
  obscureEditLabel,
} from "../shared/activityTalk";
import type { ActivityLine } from "../shared/types";
import { renderActivityDetail } from "./activityDetailView";

/** Stable row title. Payload dumps stay collapsed behind this label. */
export function stepTitle(line: ActivityLine): string {
  const talk = interpretActivityLine(line);
  if (talk.hasEdit && isGenericActivityLabel(line.label)) {
    return obscureEditLabel(line.detail || "");
  }
  if (isGenericActivityLabel(line.label)) {
    if (talk.talk) return clipTitle(talk.talk);
    return talk.verb || "Thinking";
  }
  if (isPayloadText(line.label) || isPayloadText(line.detail || "")) {
    if (/^Writing |^Editing /i.test(line.label)) return line.label;
    return obscureEditLabel(line.detail || line.label);
  }
  return line.label;
}

function clipTitle(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function isLiveCliRow(label: string): boolean {
  return (
    label === "Asking Cursor" ||
    label === "Continuing chat" ||
    label === "Thinking" ||
    label === "Writing" ||
    label === "Reading" ||
    label === "Applying"
  );
}

function isPinnedToBottom(el: HTMLElement, slack = 16): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}

function pinLogIfNeeded(detail: HTMLElement, stick: boolean): void {
  if (!stick) return;
  detail.scrollTop = detail.scrollHeight;
  requestAnimationFrame(() => {
    detail.scrollTop = detail.scrollHeight;
  });
}

function guardHostScroll(detail: HTMLElement): void {
  if (detail.dataset.scrollGuard === "1") return;
  detail.dataset.scrollGuard = "1";
  detail.dataset.stickBottom = "1";
  detail.addEventListener("scroll", () => {
    detail.dataset.stickBottom = isPinnedToBottom(detail) ? "1" : "0";
  });
}

function existingLabel(item: HTMLLIElement): HTMLElement | null {
  return item.querySelector(".activity-item-label");
}

function makeLabel(text: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "activity-item-label";
  const inner = document.createElement("span");
  inner.className = "activity-item-text";
  inner.textContent = text;
  wrap.append(inner);
  return wrap;
}

function makeCaret(): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "activity-item-caret";
  caret.setAttribute("aria-hidden", "true");
  return caret;
}

function setLabelText(label: HTMLElement | null, text: string): void {
  if (!label) return;
  const inner = label.querySelector(":scope > .activity-item-text");
  if (inner) {
    if (inner.textContent !== text) inner.textContent = text;
    return;
  }
  label.replaceChildren();
  const next = document.createElement("span");
  next.className = "activity-item-text";
  next.textContent = text;
  label.append(next);
}

function guardStep(step: HTMLDetailsElement): void {
  if (step.dataset.guarded === "1") return;
  step.dataset.guarded = "1";
  step.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

function fillStepDetail(host: HTMLElement, line: ActivityLine): void {
  const raw = line.detail ?? "";
  const kind = isLiveCliRow(line.label)
    ? "cli"
    : line.label === "Page snapshot"
      ? "snapshot"
      : line.state === "error"
        ? "error"
        : "detail";
  if (host.dataset.raw === raw && host.dataset.kind === kind) return;

  guardHostScroll(host);
  const stick =
    host.dataset.stickBottom !== "0" && isPinnedToBottom(host);
  host.dataset.raw = raw;
  host.dataset.kind = kind;
  if (kind === "snapshot" || kind === "error") {
    host.classList.remove("activity-detail");
    if (host.textContent !== raw) {
      host.replaceChildren();
      host.textContent = raw;
    }
    pinLogIfNeeded(host, stick);
  } else {
    // In-place field updates preserve nested OUTPUT scroll positions.
    renderActivityDetail(host, raw);
    pinLogIfNeeded(host, stick);
  }
}

function ensureStep(
  item: HTMLLIElement,
  line: ActivityLine,
): HTMLDetailsElement {
  let step = item.querySelector(":scope > .activity-step") as
    | HTMLDetailsElement
    | null;
  if (step) {
    guardStep(step);
    const summary = step.querySelector(":scope > .activity-item-summary");
    if (summary && !summary.querySelector(":scope > .activity-item-caret")) {
      summary.append(makeCaret());
    }
    return step;
  }

  step = document.createElement("details");
  step.className = "activity-step";
  step.open = false;
  guardStep(step);

  const summary = document.createElement("summary");
  summary.className = "activity-item-summary";
  summary.append(existingLabel(item) ?? makeLabel(stepTitle(line)), makeCaret());

  const detail = document.createElement("div");
  detail.className = "activity-item-detail";

  step.append(summary, detail);
  item.append(step);
  return step;
}

function showPlainLabel(item: HTMLLIElement, line: ActivityLine): HTMLElement {
  const step = item.querySelector(":scope > .activity-step");
  let label = existingLabel(item);
  if (step) {
    step.remove();
    if (label) item.append(label);
  }
  if (!label) {
    label = makeLabel(stepTitle(line));
    item.append(label);
  }
  return label;
}

/** Status-poll ticks refresh this dropdown only — never the latest-status line. */
export function syncActivityDetail(
  item: HTMLLIElement,
  line: ActivityLine,
): void {
  if (!line.detail) return;
  const step = ensureStep(item, line);
  const detail = step.querySelector(":scope > .activity-item-detail") as
    | HTMLElement
    | null;
  if (detail) fillStepDetail(detail, line);
}

/** History row: static label, optional expand-to-see-detail. No shimmer. */
export function syncActivityItem(
  item: HTMLLIElement,
  line: ActivityLine,
): void {
  const nextClass = `activity-item is-${line.state}`;
  if (item.className !== nextClass) item.className = nextClass;

  const hasDetail = Boolean(line.detail);
  const label = hasDetail
    ? (ensureStep(item, line), existingLabel(item))
    : showPlainLabel(item, line);

  setLabelText(label, stepTitle(line));
  if (hasDetail) syncActivityDetail(item, line);
}
