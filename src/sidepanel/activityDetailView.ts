import {
  parseActivityDetail,
  type ActivityField,
} from "./activityDetail";

const MAX_FIELD_CHARS = 20_000;

const EDIT_KEYS = new Set(["css", "overlayHtml", "runtime", "ops", "edit"]);

export function renderActivityDetail(host: HTMLElement, raw: string): void {
  const parsed = parseActivityDetail(raw);
  host.replaceChildren();

  if (parsed.fallback != null) {
    host.textContent = parsed.fallback;
    return;
  }

  host.classList.add("activity-detail");

  if (parsed.thinking) {
    const thought = document.createElement("p");
    thought.className = "activity-detail-thinking";
    thought.textContent = parsed.thinking;
    host.append(thought);
  }

  if (parsed.steps.length) {
    const list = document.createElement("ul");
    list.className = "activity-detail-steps";
    for (const step of parsed.steps) {
      const item = document.createElement("li");
      item.className = "activity-detail-step";
      item.textContent = step;
      list.append(item);
    }
    host.append(list);
  }

  for (const field of parsed.fields) {
    host.append(renderField(field));
  }
}

function renderField(field: ActivityField): HTMLElement {
  const code = document.createElement("pre");
  code.className = `activity-detail-code is-${field.lang}`;
  const value =
    field.value.length > MAX_FIELD_CHARS
      ? `${field.value.slice(0, MAX_FIELD_CHARS)}\n…`
      : field.value;
  code.textContent = value;

  if (EDIT_KEYS.has(field.key)) {
    const wrap = document.createElement("details");
    wrap.className = "activity-detail-edit";
    const summary = document.createElement("summary");
    summary.className = "activity-detail-edit-summary";
    summary.textContent =
      field.key === "runtime" ? "Editing scene" : field.label;
    wrap.append(summary, code);
    return wrap;
  }

  const block = document.createElement("section");
  block.className = "activity-detail-block";
  block.dataset.field = field.key;

  const label = document.createElement("div");
  label.className = "activity-detail-label";
  label.textContent = field.label;

  block.append(label, code);
  return block;
}
