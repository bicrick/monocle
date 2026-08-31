import {
  FALLBACK_CATALOG,
  effortLabel,
  isCatalog,
  isCursorFamily,
  modelTitle,
  paramValue,
  pickSlug,
  resolveSelection,
  summaryForSlug,
  type CatalogModel,
  type ModelCatalog,
} from "../shared/models";
import type { RuntimeMessage, Settings } from "../shared/types";

type PickerView = "root" | "models" | "effort";

/**
 * Compact composer model control. Fast · Effort · Model, backed by
 * companion GET /models (Cursor CLI catalog). Persists the --model slug.
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
  let currentSlug = "auto";
  let catalog: ModelCatalog = FALLBACK_CATALOG;
  let cached: Settings | null = null;
  let timer: number | null = null;
  let base = "http://127.0.0.1:8787";
  let view: PickerView = "root";
  let search = "";
  let catalogAt = 0;

  function setLabel(slug: string): void {
    currentSlug = slug || "auto";
    const text = summaryForSlug(catalog, currentSlug);
    labelEl.textContent = text;
    if (menu.hidden) {
      trigger.title = `${modelTitle(catalog, currentSlug)} · ${text}`;
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

  function current(): {
    model: CatalogModel | null;
    variant: ReturnType<typeof resolveSelection>["variant"];
  } {
    return resolveSelection(catalog, currentSlug);
  }

  function renderRoot(): void {
    const { model, variant } = current();
    const hasFast = model?.parameters.some((p) => p.id === "fast");
    const hasEffort = model?.parameters.some((p) => p.id === "effort");

    if (hasFast && model) {
      const on = paramValue(variant, "fast") === "true";
      const row = el("button", "model-picker-row is-toggle");
      row.type = "button";
      const sw = el("span", `model-picker-switch${on ? " is-on" : ""}`);
      sw.setAttribute("aria-hidden", "true");
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", on ? "true" : "false");
      row.append(el("span", "model-picker-row-key", "Fast"), sw);
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void selectSlug(
          pickSlug(model, [
            ...(variant?.params.filter((p) => p.id !== "fast") ?? []),
            { id: "fast", value: on ? "false" : "true" },
          ]),
          { keepOpen: true },
        );
      });
      menu.append(row);
    }

    if (hasEffort && model) {
      const row = el("button", "model-picker-row");
      row.type = "button";
      row.setAttribute("aria-haspopup", "listbox");
      row.append(
        el("span", "model-picker-row-key", "Effort"),
        el("span", "model-picker-row-value", effortLabel(model, variant)),
        caret("next"),
      );
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        view = "effort";
        renderMenu();
      });
      menu.append(row);
    }

    const modelRow = el("button", "model-picker-row");
    modelRow.type = "button";
    modelRow.setAttribute("aria-haspopup", "listbox");
    modelRow.append(
      el("span", "model-picker-row-key", "Model"),
      el("span", "model-picker-row-value", modelTitle(catalog, currentSlug)),
      caret("next"),
    );
    modelRow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = "models";
      search = "";
      renderMenu();
    });
    menu.append(modelRow);
  }

  function renderBack(title: string, to: PickerView): void {
    const back = el("button", "model-picker-back");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.append(caret("back"), el("span", "model-picker-back-label", title));
    back.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = to;
      renderMenu();
    });
    menu.append(back);
  }

  function renderEffort(): void {
    const { model, variant } = current();
    renderBack("Effort", "root");
    if (!model) return;
    const effort = model.parameters.find((p) => p.id === "effort");
    if (!effort) return;

    const list = el("div", "model-picker-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Effort");
    const currentEffort = paramValue(variant, "effort");

    for (const value of effort.values) {
      const opt = el("button", "model-picker-option");
      opt.type = "button";
      opt.setAttribute("role", "option");
      const selected = value.value === currentEffort;
      opt.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) opt.classList.add("is-selected");
      const tick = el("span", "model-picker-tick");
      tick.setAttribute("aria-hidden", "true");
      opt.append(
        el(
          "span",
          "model-picker-option-label",
          value.displayName || value.value,
        ),
        tick,
      );
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void selectSlug(
          pickSlug(model, [
            ...(variant?.params.filter((p) => p.id !== "effort") ?? []),
            { id: "effort", value: value.value },
          ]),
          { keepOpen: true, view: "root" },
        );
      });
      list.append(opt);
    }
    menu.append(list);
  }

  function renderModels(): void {
    renderBack("Model", "root");

    const searchWrap = el("div", "model-picker-search-wrap");
    const input = el("input", "model-picker-search") as HTMLInputElement;
    input.type = "search";
    input.placeholder = "Search models";
    input.value = search;
    input.setAttribute("aria-label", "Search models");
    input.addEventListener("input", () => {
      search = input.value;
      view = "models";
      const keep = input;
      renderMenu();
      const next = menu.querySelector(
        ".model-picker-search",
      ) as HTMLInputElement | null;
      if (next) {
        next.focus();
        next.value = keep.value;
        next.setSelectionRange(keep.value.length, keep.value.length);
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => e.stopPropagation());
    searchWrap.append(input);
    menu.append(searchWrap);

    const q = search.trim().toLowerCase();
    const matches = (m: CatalogModel) =>
      !q ||
      m.displayName.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.variants.some((v) => v.slug.toLowerCase().includes(q));

    const cursor: CatalogModel[] = [];
    const other: CatalogModel[] = [];
    for (const model of catalog.models) {
      if (!matches(model)) continue;
      if (isCursorFamily(model.id)) cursor.push(model);
      else other.push(model);
    }

    const { model: selected } = current();
    if (
      currentSlug &&
      !catalog.models.some((m) => m.variants.some((v) => v.slug === currentSlug))
    ) {
      const custom: CatalogModel = {
        id: currentSlug,
        displayName: currentSlug,
        parameters: [],
        variants: [
          {
            slug: currentSlug,
            displayName: currentSlug,
            params: [],
            isDefault: true,
          },
        ],
      };
      if (matches(custom)) other.push(custom);
    }

    const list = el("div", "model-picker-list is-scroll");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Model");

    const addSection = (title: string, rows: CatalogModel[]) => {
      if (!rows.length) return;
      list.append(el("div", "model-picker-section", title));
      for (const model of rows) {
        const opt = el("button", "model-picker-option");
        opt.type = "button";
        opt.setAttribute("role", "option");
        const selectedHere = selected?.id === model.id;
        opt.setAttribute("aria-selected", selectedHere ? "true" : "false");
        if (selectedHere) opt.classList.add("is-selected");
        const tick = el("span", "model-picker-tick");
        tick.setAttribute("aria-hidden", "true");
        const badge = selectedHere
          ? summaryForSlug(catalog, currentSlug)
          : model.variants.find((v) => v.isDefault)?.displayName ||
            model.variants[0]?.displayName ||
            "";
        opt.append(el("span", "model-picker-option-label", model.displayName));
        if (badge && badge !== model.displayName && badge !== "Standard") {
          opt.append(el("span", "model-picker-badge", badge));
        }
        opt.append(tick);
        opt.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const keep = current().variant?.params ?? [];
          void selectSlug(pickSlug(model, keep));
        });
        list.append(opt);
      }
    };

    addSection("Cursor", cursor);
    addSection("Other", other);
    if (!cursor.length && !other.length) {
      list.append(el("div", "model-picker-empty", "No models match"));
    }
    menu.append(list);
  }

  function renderMenu(): void {
    menu.replaceChildren();
    menu.classList.toggle("is-wide", view === "models");
    if (view === "models") renderModels();
    else if (view === "effort") renderEffort();
    else renderRoot();
  }

  function setOpen(open: boolean): void {
    if (!open) {
      view = "root";
      search = "";
    }
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    root.classList.toggle("is-open", open);
    if (open) {
      trigger.removeAttribute("title");
      renderMenu();
      if (Date.now() - catalogAt > 5 * 60 * 1000) void loadCatalog();
    } else {
      trigger.title = `${modelTitle(catalog, currentSlug)} · ${summaryForSlug(catalog, currentSlug)}`;
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

  async function selectSlug(
    id: string,
    opts: { keepOpen?: boolean; view?: PickerView } = {},
  ): Promise<void> {
    if (!opts.keepOpen) setOpen(false);
    setLabel(id);
    if (opts.view) view = opts.view;
    if (opts.keepOpen) renderMenu();
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

  async function loadCatalog(): Promise<void> {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/models`);
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!isCatalog(data) || !data.models.length) return;
      catalog = data;
      catalogAt = Date.now();
      setLabel(currentSlug);
      if (!menu.hidden) renderMenu();
    } catch {
      // keep fallback
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
    if (view !== "root") {
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
      void loadCatalog();
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(() => void ping(), 8000);
    },
    stop() {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    },
  };
}
