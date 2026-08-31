/** Cursor CLI model catalog (companion `GET /models`) and offline aliases. */

export interface ModelPreset {
  id: string;
  label: string;
}

export interface ModelParamValue {
  value: string;
  displayName?: string;
}

export interface ModelParameter {
  id: string;
  displayName?: string;
  values: ModelParamValue[];
}

export interface ModelParamSelection {
  id: string;
  value: string;
}

export interface ModelVariant {
  slug: string;
  displayName: string;
  params: ModelParamSelection[];
  isDefault?: boolean;
}

export interface CatalogModel {
  id: string;
  displayName: string;
  parameters: ModelParameter[];
  variants: ModelVariant[];
}

export interface ModelCatalog {
  models: CatalogModel[];
  source?: "cli" | "fallback";
  error?: string;
}

export const CURSOR_CLI_MODELS: ModelPreset[] = [
  { id: "auto", label: "Auto" },
  { id: "composer", label: "Composer" },
  { id: "sonnet", label: "Sonnet" },
  { id: "gpt", label: "GPT" },
  { id: "grok", label: "Grok" },
];

export const FALLBACK_CATALOG: ModelCatalog = {
  source: "fallback",
  models: CURSOR_CLI_MODELS.map((m) => ({
    id: m.id,
    displayName: m.label,
    parameters: [],
    variants: [
      {
        slug: m.id,
        displayName: m.label,
        params: [],
        isDefault: true,
      },
    ],
  })),
};

export function labelForModel(id: string): string {
  const preset = CURSOR_CLI_MODELS.find((m) => m.id === id);
  return preset?.label ?? (id.trim() || "Auto");
}

export function isCursorFamily(id: string): boolean {
  return (
    id === "auto" || id.startsWith("cursor-") || id.startsWith("composer-")
  );
}

function effortKey(value: string | undefined): string | undefined {
  if (value === "extra-high" || value === "xhigh") return "xhigh";
  return value;
}

export function paramValue(
  variant: ModelVariant | null | undefined,
  id: string,
): string | undefined {
  return variant?.params.find((p) => p.id === id)?.value;
}

export function resolveSelection(
  catalog: ModelCatalog,
  slug: string,
): { model: CatalogModel | null; variant: ModelVariant | null } {
  const id = slug.trim() || "auto";
  for (const model of catalog.models) {
    const variant = model.variants.find((v) => v.slug === id);
    if (variant) return { model, variant };
    if (model.id === id) {
      const fallback =
        model.variants.find((v) => v.isDefault) ?? model.variants[0] ?? null;
      return { model, variant: fallback };
    }
  }
  return { model: null, variant: null };
}

export function pickSlug(
  model: CatalogModel,
  wanted: ModelParamSelection[],
): string {
  const wantedMap = new Map(
    wanted.map((p) => [p.id, p.id === "effort" ? effortKey(p.value) : p.value]),
  );
  let best = model.variants[0];
  let bestScore = -Infinity;
  for (const variant of model.variants) {
    let score = variant.isDefault ? 0.5 : 0;
    for (const p of variant.params) {
      const got = p.id === "effort" ? effortKey(p.value) : p.value;
      const want = wantedMap.get(p.id);
      if (want == null) continue;
      score += got === want ? 2 : -1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = variant;
    }
  }
  return best?.slug ?? model.id;
}

export function summaryForSlug(catalog: ModelCatalog, slug: string): string {
  const { variant, model } = resolveSelection(catalog, slug);
  if (variant?.displayName) return variant.displayName;
  if (model?.displayName) return model.displayName;
  return labelForModel(slug);
}

export function modelTitle(catalog: ModelCatalog, slug: string): string {
  const { model } = resolveSelection(catalog, slug);
  return model?.displayName ?? labelForModel(slug);
}

export function effortLabel(
  model: CatalogModel,
  variant: ModelVariant | null,
): string {
  const value = paramValue(variant, "effort");
  const def = model.parameters
    .find((p) => p.id === "effort")
    ?.values.find((v) => v.value === value);
  return def?.displayName ?? value ?? "—";
}

export function isCatalog(value: unknown): value is ModelCatalog {
  if (!value || typeof value !== "object") return false;
  const models = (value as ModelCatalog).models;
  return Array.isArray(models) && models.every((m) => m && typeof m.id === "string");
}
