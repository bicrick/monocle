import type { ProviderKind, RuntimeMessage, Settings } from "../shared/types";
import { BASE_URL_DEFAULTS, MODEL_DEFAULTS } from "../shared/types";

const providerEl = document.getElementById("provider") as HTMLSelectElement;
const modelEl = document.getElementById("model") as HTMLInputElement;
const apiKeyEl = document.getElementById("apiKey") as HTMLInputElement;
const baseUrlEl = document.getElementById("baseUrl") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const savedEl = document.getElementById("saved") as HTMLElement;
const apiKeyLabel = document.getElementById("api-key-label") as HTMLElement;
const cliHelp = document.getElementById("cli-help") as HTMLElement;
const companionStatus = document.getElementById(
  "companion-status",
) as HTMLElement;
const companionLog = document.getElementById("companion-log") as HTMLElement;

function isCli(provider: string): boolean {
  return provider === "cursor-cli";
}

function syncProviderUi(): void {
  const cli = isCli(providerEl.value);
  apiKeyLabel.hidden = cli;
  cliHelp.hidden = !cli;
  companionStatus.hidden = !cli;
  companionLog.hidden = !cli;
  if (cli) void pingCompanion();
}

async function pingCompanion(): Promise<void> {
  const base = (baseUrlEl.value || BASE_URL_DEFAULTS["cursor-cli"]).replace(
    /\/$/,
    "",
  );
  companionStatus.textContent = "Companion: checking…";
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      ok?: boolean;
      agent?: string;
      logPath?: string;
      activeSessions?: number;
      maxConcurrent?: number;
    };
    const load =
      data.maxConcurrent != null
        ? ` — ${data.activeSessions ?? 0}/${data.maxConcurrent} agents`
        : "";
    companionStatus.textContent = data.ok
      ? `Companion: running (${data.agent || "agent"})${load}`
      : "Companion: reached, but not ready";
    companionLog.textContent = data.logPath
      ? `Logs: ${data.logPath}`
      : "Logs: GET /logs on the companion";
  } catch {
    companionStatus.textContent =
      "Companion: not running. In the repo: npm run dev";
    companionLog.textContent =
      "Logs: npm run dev starts the companion; see logs/companion.log";
  }
}

function fill(settings: Settings): void {
  providerEl.value = settings.provider;
  modelEl.value = settings.model;
  apiKeyEl.value = settings.apiKey;
  baseUrlEl.value = settings.baseUrl || BASE_URL_DEFAULTS[settings.provider];
  syncProviderUi();
}

providerEl.addEventListener("change", () => {
  const provider = providerEl.value as ProviderKind;
  if (!modelEl.value || Object.values(MODEL_DEFAULTS).includes(modelEl.value)) {
    modelEl.value = MODEL_DEFAULTS[provider];
  }
  if (
    !baseUrlEl.value ||
    Object.values(BASE_URL_DEFAULTS).includes(baseUrlEl.value)
  ) {
    baseUrlEl.value = BASE_URL_DEFAULTS[provider];
  }
  syncProviderUi();
});

baseUrlEl.addEventListener("change", () => {
  if (isCli(providerEl.value)) void pingCompanion();
});

saveBtn.addEventListener("click", async () => {
  const settings: Settings = {
    provider: providerEl.value as ProviderKind,
    model: modelEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
    baseUrl: baseUrlEl.value.trim(),
  };
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings,
  } satisfies RuntimeMessage);
  savedEl.hidden = false;
  setTimeout(() => {
    savedEl.hidden = true;
  }, 1500);
  if (isCli(settings.provider)) void pingCompanion();
});

void (async () => {
  const res = (await chrome.runtime.sendMessage({
    type: "GET_SETTINGS",
  })) as RuntimeMessage;
  if (res?.type === "SETTINGS") fill(res.settings);
})();
