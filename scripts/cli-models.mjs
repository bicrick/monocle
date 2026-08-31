/**
 * Parse `agent --list-models` into a Cursor-style catalog:
 * family + Fast / Effort variants. Slugs stay the --model values.
 */

const EFFORT_TOKENS = [
  "extra-high",
  "xhigh",
  "minimal",
  "medium",
  "none",
  "low",
  "high",
  "max",
];

const EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  "extra-high": "Extra High",
  max: "Max",
};

const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "max",
];

const SKIP_LINE =
  /^(available models|tip:|use --model|parameterized models)/i;

/**
 * @param {string} slug
 * @returns {{ family: string, effort: string | null, fast: boolean }}
 */
export function parseModelSlug(slug) {
  let rest = String(slug || "").trim();
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  let thinkingSuffix = false;
  if (rest.endsWith("-thinking")) {
    thinkingSuffix = true;
    rest = rest.slice(0, -9);
  }
  let effort = null;
  for (const token of EFFORT_TOKENS) {
    const suffix = `-${token}`;
    if (rest.endsWith(suffix)) {
      effort = token;
      rest = rest.slice(0, -suffix.length);
      break;
    }
  }
  if (thinkingSuffix) rest = `${rest}-thinking`;
  return { family: rest || slug, effort, fast };
}

/**
 * @param {string} label
 */
export function cleanFamilyLabel(label) {
  return String(label || "")
    .replace(/\s*\((?:current|default)(?:,\s*(?:current|default))?\)\s*$/i, "")
    .replace(/\s+Fast$/i, "")
    .replace(/\s+(None|Low|Medium|High|Extra High|Max|Minimal)$/i, "")
    .replace(/\s+1M(?=\s+Thinking$)/i, "")
    .replace(/\s+1M$/i, "")
    .trim();
}

/**
 * @param {string} line
 * @returns {{ slug: string, label: string } | null}
 */
export function parseListModelsLine(line) {
  const text = String(line || "").trim();
  if (!text || SKIP_LINE.test(text)) return null;
  const labeled = text.match(/^([a-zA-Z0-9._+-]+)\s+-\s+(.+)$/);
  if (labeled) {
    return {
      slug: labeled[1],
      label: labeled[2]
        .replace(/\s*\((?:current|default)(?:,\s*(?:current|default))?\)\s*$/i, "")
        .trim(),
    };
  }
  if (/^[a-zA-Z0-9._+-]+$/.test(text)) {
    return { slug: text, label: text };
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ slug: string, label: string }[]}
 */
export function parseListModelsText(text) {
  const rows = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const row = parseListModelsLine(line);
    if (!row || seen.has(row.slug)) continue;
    seen.add(row.slug);
    rows.push(row);
  }
  return rows;
}

function effortLabel(token) {
  return EFFORT_LABELS[token] || token;
}

function variantDisplay(effort, fast, fallback) {
  const parts = [];
  if (effort) parts.push(effortLabel(effort));
  if (fast) parts.push("Fast");
  return parts.join(" ") || fallback || "Standard";
}

function defaultVariantIndex(variants) {
  const score = (v) => {
    const effort = v.params.find((p) => p.id === "effort")?.value;
    const fast = v.params.find((p) => p.id === "fast")?.value === "true";
    let n = 0;
    if (!fast) n += 10;
    if (effort === "medium") n += 5;
    else if (effort === "high") n += 3;
    else if (!effort) n += 4;
    return n;
  };
  let best = 0;
  for (let i = 1; i < variants.length; i++) {
    if (score(variants[i]) > score(variants[best])) best = i;
  }
  return best;
}

function fallbackRows() {
  return [
    { slug: "auto", label: "Auto" },
    { slug: "composer", label: "Composer" },
    { slug: "sonnet", label: "Sonnet" },
    { slug: "gpt", label: "GPT" },
    { slug: "grok", label: "Grok" },
  ];
}

/**
 * @param {{ slug: string, label: string }[]} rows
 */
export function catalogFromRows(rows) {
  /** @type {Map<string, { id: string, labels: string[], variants: object[], hasFast: boolean }>} */
  const groups = new Map();
  const order = [];

  for (const row of rows) {
    const parsed = parseModelSlug(row.slug);
    const family = parsed.family;
    if (!groups.has(family)) {
      groups.set(family, {
        id: family,
        labels: [],
        variants: [],
        hasFast: false,
      });
      order.push(family);
    }
    const group = groups.get(family);
    if (parsed.fast) group.hasFast = true;
    const cleaned = cleanFamilyLabel(row.label);
    if (cleaned) group.labels.push(cleaned);
    group.variants.push({
      slug: row.slug,
      parsed,
    });
  }

  for (const group of groups.values()) {
    const familyLabel =
      [...group.labels].sort((a, b) => a.length - b.length)[0] || group.id;
    group.displayName = familyLabel;
    group.variants = group.variants.map(({ slug, parsed }) => {
      /** @type {{ id: string, value: string }[]} */
      const params = [];
      if (parsed.effort) params.push({ id: "effort", value: parsed.effort });
      if (group.hasFast) {
        params.push({ id: "fast", value: parsed.fast ? "true" : "false" });
      }
      return {
        slug,
        displayName: variantDisplay(parsed.effort, parsed.fast, familyLabel),
        params,
      };
    });
  }

  const models = order.map((id) => {
    const group = groups.get(id);
    const variants = group.variants;
    const def = defaultVariantIndex(variants);
    if (variants[def]) variants[def].isDefault = true;

    const efforts = [
      ...new Set(
        variants
          .map((v) => v.params.find((p) => p.id === "effort")?.value)
          .filter(Boolean),
      ),
    ].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const hasFast = variants.some((v) =>
      v.params.some((p) => p.id === "fast" && p.value === "true"),
    );
    const hasNonFast = variants.some(
      (v) => !v.params.some((p) => p.id === "fast" && p.value === "true"),
    );

    /** @type {object[]} */
    const parameters = [];
    if (hasFast && hasNonFast) {
      parameters.push({
        id: "fast",
        displayName: "Fast",
        values: [
          { value: "false" },
          { value: "true", displayName: "Fast" },
        ],
      });
    }
    if (efforts.length > 1) {
      parameters.push({
        id: "effort",
        displayName: "Effort",
        values: efforts.map((value) => ({
          value,
          displayName: effortLabel(value),
        })),
      });
    }

    return {
      id,
      displayName: group.displayName || id,
      parameters,
      variants,
    };
  });

  return { models, source: "cli" };
}

export function fallbackCatalog() {
  return { ...catalogFromRows(fallbackRows()), source: "fallback" };
}

export function parseListModels(text) {
  const rows = parseListModelsText(text);
  if (!rows.length) return fallbackCatalog();
  return catalogFromRows(rows);
}
