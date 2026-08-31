import assert from "node:assert/strict";
import {
  catalogFromRows,
  cleanFamilyLabel,
  parseListModels,
  parseModelSlug,
} from "./cli-models.mjs";
import {
  FALLBACK_CATALOG,
  pickSlug,
  resolveSelection,
  summaryForSlug,
} from "../src/shared/models";

const FIXTURE = `
Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
cursor-grok-4.6-low - Cursor Grok 4.6 Low
cursor-grok-4.6-low-fast - Cursor Grok 4.6 Low Fast
cursor-grok-4.6-medium - Cursor Grok 4.6 Medium
cursor-grok-4.6-medium-fast - Cursor Grok 4.6 Medium Fast
cursor-grok-4.6-high - Cursor Grok 4.6
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
cursor-grok-4.6-xhigh - Cursor Grok 4.6 Extra High
cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast
claude-opus-5-high - Claude Opus 5 1M
claude-opus-5-high-fast - Claude Opus 5 1M Fast
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
claude-opus-5-thinking-high-fast - Claude Opus 5 1M Thinking Fast
claude-4.6-sonnet-medium - Claude Sonnet 4.6 1M
claude-4.6-sonnet-medium-thinking - Claude Sonnet 4.6 1M Thinking
gpt-5.5-extra-high - GPT-5.5 1M Extra High
gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast
gemini-3.1-pro - Gemini 3.1 Pro

Tip: use --model <id> to switch.
`;

assert.deepEqual(parseModelSlug("cursor-grok-4.6-high-fast"), {
  family: "cursor-grok-4.6",
  effort: "high",
  fast: true,
});
assert.deepEqual(parseModelSlug("composer-2.5"), {
  family: "composer-2.5",
  effort: null,
  fast: false,
});
assert.deepEqual(parseModelSlug("claude-opus-5-thinking-high"), {
  family: "claude-opus-5-thinking",
  effort: "high",
  fast: false,
});
assert.deepEqual(parseModelSlug("claude-4.6-sonnet-medium-thinking"), {
  family: "claude-4.6-sonnet-thinking",
  effort: "medium",
  fast: false,
});
assert.deepEqual(parseModelSlug("gpt-5.5-extra-high-fast"), {
  family: "gpt-5.5",
  effort: "extra-high",
  fast: true,
});

assert.equal(cleanFamilyLabel("Cursor Grok 4.6 Extra High Fast"), "Cursor Grok 4.6");
assert.equal(cleanFamilyLabel("Claude Opus 5 1M Thinking"), "Claude Opus 5 Thinking");
assert.equal(cleanFamilyLabel("Auto (current, default)"), "Auto");

const catalog = parseListModels(FIXTURE);
assert.equal(catalog.source, "cli");

const grok = catalog.models.find((m) => m.id === "cursor-grok-4.6");
assert.ok(grok);
assert.equal(grok.displayName, "Cursor Grok 4.6");
assert.ok(grok.parameters.some((p) => p.id === "fast"));
assert.ok(grok.parameters.some((p) => p.id === "effort"));
assert.equal(grok.variants.length, 8);

const composer = catalog.models.find((m) => m.id === "composer-2.5");
assert.ok(composer);
assert.ok(composer.parameters.some((p) => p.id === "fast"));
assert.ok(!composer.parameters.some((p) => p.id === "effort"));

const thinking = catalog.models.find((m) => m.id === "claude-opus-5-thinking");
assert.ok(thinking);
assert.equal(thinking.displayName, "Claude Opus 5 Thinking");

const sonnetThink = catalog.models.find(
  (m) => m.id === "claude-4.6-sonnet-thinking",
);
assert.ok(sonnetThink);
assert.equal(sonnetThink.displayName, "Claude Sonnet 4.6 Thinking");

const gemini = catalog.models.find((m) => m.id === "gemini-3.1-pro");
assert.ok(gemini);
assert.equal(gemini.parameters.length, 0);
assert.equal(gemini.variants[0]?.slug, "gemini-3.1-pro");

const highFast = pickSlug(grok, [
  { id: "effort", value: "high" },
  { id: "fast", value: "true" },
]);
assert.equal(highFast, "cursor-grok-4.6-high-fast");

const xhighKept = pickSlug(grok, [
  { id: "effort", value: "extra-high" },
  { id: "fast", value: "false" },
]);
assert.equal(xhighKept, "cursor-grok-4.6-xhigh");

const { variant } = resolveSelection(catalog, "cursor-grok-4.6-high-fast");
assert.equal(variant?.displayName, "High Fast");
assert.equal(summaryForSlug(catalog, "cursor-grok-4.6-high-fast"), "High Fast");
assert.equal(summaryForSlug(catalog, "auto"), "Auto");
assert.equal(summaryForSlug(FALLBACK_CATALOG, "grok"), "Grok");

const empty = parseListModels("Available models\n\nTip: nope");
assert.equal(empty.source, "fallback");
assert.equal(empty.models.length, 5);

const fromRows = catalogFromRows([
  { slug: "auto", label: "Auto" },
  { slug: "composer-2.5-fast", label: "Composer 2.5 Fast" },
]);
assert.equal(fromRows.models[1]?.id, "composer-2.5");

console.log("cli model catalog tests passed");
