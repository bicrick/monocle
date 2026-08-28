/** Cursor CLI `--model` aliases the composer picker exposes. Custom IDs stay in options. */

export interface ModelPreset {
  id: string;
  label: string;
}

export const CURSOR_CLI_MODELS: ModelPreset[] = [
  { id: "auto", label: "Auto" },
  { id: "composer", label: "Composer" },
  { id: "sonnet", label: "Sonnet" },
  { id: "gpt", label: "GPT" },
  { id: "grok", label: "Grok" },
];

export function labelForModel(id: string): string {
  const preset = CURSOR_CLI_MODELS.find((m) => m.id === id);
  return preset?.label ?? (id.trim() || "Auto");
}
