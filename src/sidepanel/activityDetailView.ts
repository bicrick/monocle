import {
  parseActivityDetail,
  type ActivityField,
} from "./activityDetail";

const MAX_FIELD_CHARS = 20_000;

export function renderActivityDetail(host: HTMLElement, raw: string): void {
  const parsed = parseActivityDetail(raw);
  host.replaceChildren();

  if (parsed.fallback != null) {
    host.textContent = parsed.fallback;
    return;
  }

  host.classList.add("activity-detail");

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
  const block = document.createElement("section");
  block.className = "activity-detail-block";
  block.dataset.field = field.key;

  const label = document.createElement("div");
  label.className = "activity-detail-label";
  label.textContent = field.label;

  const code = document.createElement("pre");
  code.className = `activity-detail-code is-${field.lang}`;
  const value =
    field.value.length > MAX_FIELD_CHARS
      ? `${field.value.slice(0, MAX_FIELD_CHARS)}\n…`
      : field.value;
  code.textContent = value;

  block.append(label, code);
  return block;
}
