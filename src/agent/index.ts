import type { Settings } from "../shared/types";
import { BASE_URL_DEFAULTS, DEFAULT_SETTINGS, MODEL_DEFAULTS } from "../shared/types";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { AgentProvider } from "./types";
import { CursorCliProvider } from "./cursorCli";
import { StatelessLlmProvider } from "./statelessLlm";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  const raw = (stored.settings ?? {}) as Partial<Settings>;
  const provider = raw.provider ?? DEFAULT_SETTINGS.provider;
  return {
    provider,
    apiKey: raw.apiKey ?? "",
    model: raw.model || MODEL_DEFAULTS[provider],
    baseUrl: raw.baseUrl || BASE_URL_DEFAULTS[provider],
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function createProvider(): Promise<AgentProvider> {
  const settings = await loadSettings();

  if (settings.provider === "cursor-cli") {
    return new CursorCliProvider(settings, SYSTEM_PROMPT);
  }

  if (!settings.apiKey.trim()) {
    throw new Error("Add an API key in Monacle options before prompting.");
  }
  return new StatelessLlmProvider(settings, SYSTEM_PROMPT);
}
