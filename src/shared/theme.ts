import type { Settings, ThemeKind } from "./types";

export function resolveTheme(theme: unknown): ThemeKind {
  return theme === "light" || theme === "dark" ? theme : "system";
}

export function applyTheme(theme: ThemeKind | undefined): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

export function startTheme(): void {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    applyTheme("system");
    return;
  }

  void storage.get("settings").then((stored) => {
    const raw = (stored.settings ?? {}) as Partial<Settings>;
    applyTheme(raw.theme);
  });

  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const next = changes.settings.newValue as Partial<Settings> | undefined;
    applyTheme(next?.theme);
  });
}
