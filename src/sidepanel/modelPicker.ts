import { CURSOR_CLI_MODELS, labelForModel } from "../shared/models";
import type { RuntimeMessage, Settings } from "../shared/types";

type PickerView = "root" | "models";

/**
 * Compact composer model control. The pill opens a Cursor-style settings
 * popover (Model · current >) that drills into the CLI preset list.
 * Persists via GET_SETTINGS / SAVE_SETTINGS (same path as options).
 */
export function createModelPicker(host: HTMLElement): {
  start: (baseUrl: string) => void;
  stop: () => void;
} {
  const root = document.createElement("div");
  root.className = "model-picker";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "model-picker-trigger";
  trigger.setAttribute("aria-label", "Model");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `
    <span class="model-picker-dot" aria-hidden="true"></span>
    <span class="model-picker-label">Auto</span>
    <span class="model-picker-chevron" aria-hidden="true"></span>
  `;

  const menu = document.createElement("div");
  menu.className = "model-picker-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Model");

  root.append(trigger, menu);
  host.append(root);

  const labelEl = trigger.querySelector(".model-picker-label") as HTMLElement;
  let currentModel = "auto";
  let cached: Settings | null = null;
  let timer: number | null = null;
  let base = "http://127.0.0.1:8787";
  let view: PickerView = "root";

  function presets(): { id: string; label: string }[] {
    const rows = CURSOR_CLI_MODELS.map((m) => ({ id: m.id, label: m.label }));
    if (currentModel && !rows.some((r) => r.id === currentModel)) {
      rows.push({ id: currentModel, label: currentModel });
    }
    return rows;
  }

  function setLabel(id: string): void {
    currentModel = id || "auto";
    labelEl.textContent = labelForModel(currentModel);
    if (menu.hidden) {
      trigger.title = `Model: ${labelForModel(currentModel)}`;
    }
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function caret(direction: "next" | "back"): HTMLSpanElement {
    const mark = el("span", `model-picker-caret is-${direction}`);
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function renderRoot(): void {
    const row = el("button", "model-picker-row");
    row.type = "button";
    row.setAttribute("aria-haspopup", "listbox");
    row.append(
      el("span", "model-picker-row-key", "Model"),
      el("span", "model-picker-row-value", labelForModel(currentModel)),
      caret("next"),
    );
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = "models";
      renderMenu();
    });
    menu.append(row);
  }

  function renderModels(): void {
    const back = el("button", "model-picker-back");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.append(caret("back"), el("span", "model-picker-back-label", "Model"));
    back.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = "root";
      renderMenu();
    });
    menu.append(back);

    const list = el("div", "model-picker-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Model");

    for (const row of presets()) {
      const opt = el("button", "model-picker-option");
      opt.type = "button";
      opt.setAttribute("role", "option");
      const selected = row.id === currentModel;
      opt.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) opt.classList.add("is-selected");
      const tick = el("span", "model-picker-tick");
      tick.setAttribute("aria-hidden", "true");
      opt.append(el("span", "model-picker-option-label", row.label), tick);
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void selectModel(row.id);
      });
      list.append(opt);
    }
    menu.append(list);
  }

  function renderMenu(): void {
    menu.replaceChildren();
    if (view === "models") renderModels();
    else renderRoot();
  }

  function setOpen(open: boolean): void {
    if (!open) view = "root";
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    root.classList.toggle("is-open", open);
    if (open) {
      trigger.removeAttribute("title");
      renderMenu();
    } else {
      trigger.title = `Model: ${labelForModel(currentModel)}`;
    }
  }

  async function loadSettings(): Promise<Settings | null> {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "GET_SETTINGS",
      })) as RuntimeMessage;
      if (res?.type !== "SETTINGS") return null;
      cached = res.settings;
      return res.settings;
    } catch {
      return null;
    }
  }

  async function selectModel(id: string): Promise<void> {
    setOpen(false);
    setLabel(id);
    const settings = cached ?? (await loadSettings());
    if (!settings) return;
    const next: Settings = { ...settings, model: id };
    cached = next;
    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_SETTINGS",
        settings: next,
      } satisfies RuntimeMessage);
    } catch {
      cached = settings;
    }
  }

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(menu.hidden);
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    if (view === "models") {
      view = "root";
      renderMenu();
      return;
    }
    setOpen(false);
  });

  async function ping(): Promise<void> {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/health`, {
        method: "GET",
      });
      trigger.classList.toggle("is-online", res.ok);
      trigger.classList.toggle("is-offline", !res.ok);
    } catch {
      trigger.classList.remove("is-online");
      trigger.classList.add("is-offline");
    }
  }

  void loadSettings().then((settings) => {
    if (settings) setLabel(settings.model || "auto");
  });

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      const next = changes.settings.newValue as Settings | undefined;
      if (!next) return;
      cached = next;
      setLabel(next.model || "auto");
      if (!menu.hidden) renderMenu();
    });
  }

  return {
    start(baseUrl: string) {
      base = baseUrl || base;
      void ping();
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(() => void ping(), 8000);
    },
    stop() {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    },
  };
}
