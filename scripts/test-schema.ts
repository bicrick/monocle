import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCodeFromText,
  extractPatchFromText,
  isRuntimeSourceAllowed,
  patchFromRuntimeCode,
  validatePatch,
} from "../src/patches/schema";
import { CINEMA_DEMO_PATCH } from "../src/patches/cinemaDemo";
import { dispatchHostCall } from "../src/content/sandboxProtocol";
import { nextCanvasDim } from "../src/sandbox/safeCanvasDim";

const fromDemo = validatePatch(CINEMA_DEMO_PATCH);
assert.ok(fromDemo);
assert.ok(fromDemo!.css?.includes("ytd-masthead"));
assert.equal(fromDemo!.ops?.[0]?.type, "hide");

const fenced = extractPatchFromText(`Sure.

\`\`\`json
{
  "message": "Dimmed room",
  "css": "body { background: #000 !important; }",
  "ops": [{ "type": "hide", "selector": "#secondary" }]
}
\`\`\`
`);
assert.ok(fenced);
assert.equal(fenced!.message, "Dimmed room");

const code = extractCodeFromText(`
\`\`\`javascript
const c = monacle.canvas();
monacle.onCleanup(() => {});
\`\`\`
`);
assert.ok(code?.includes("monacle.canvas"));

const runtimeOnly = validatePatch({
  runtime: "monacle.onCleanup(() => {});",
  message: "runtime only",
});
assert.ok(runtimeOnly);
assert.ok(runtimeOnly!.runtime?.includes("onCleanup"));

assert.equal(isRuntimeSourceAllowed("chrome.tabs.query({})"), false);
assert.equal(isRuntimeSourceAllowed("browser.runtime.sendMessage({})"), false);
assert.equal(isRuntimeSourceAllowed("monacle.raf(() => {})"), true);
assert.equal(
  validatePatch({ runtime: "chrome.storage.local.get(null)" }),
  null,
);
assert.equal(extractCodeFromText("```js\nchrome.runtime.id\n```"), null);

const fromFence = patchFromRuntimeCode("monacle.css('body{}')");
assert.ok(fromFence?.runtime);
assert.equal(patchFromRuntimeCode("chrome.tabs.create({})"), null);

const insertOp = validatePatch({
  ops: [
    {
      type: "insert",
      selector: "body",
      position: "append",
      html: "<div class='coral'></div>",
    },
    { type: "remove", selector: "[data-monacle-insert]" },
  ],
});
assert.ok(insertOp?.ops?.length === 2);
assert.equal(insertOp!.ops![0].type, "insert");
assert.equal(insertOp!.ops![0].html, "<div class='coral'></div>");
assert.equal(insertOp!.ops![0].position, "append");
assert.equal(insertOp!.ops![1].type, "remove");

assert.equal(
  validatePatch({ ops: [{ type: "insert", selector: "body" }] }),
  null,
);
assert.equal(validatePatch({ ops: [{ type: "explode", selector: "x" }] }), null);
assert.equal(validatePatch(null), null);

const queried: string[] = [];
const inserted: Array<{ html: string; selector: string }> = [];
const cssWrites: string[] = [];
const queryResult = dispatchHostCall("query", ["video"], {
  query: (selector) => {
    queried.push(selector);
    return [{ tag: "video", id: "player" }];
  },
  insert: (html, opts) => {
    inserted.push({ html, selector: opts.selector });
    return [];
  },
  css: (text) => {
    cssWrites.push(text);
  },
  style: () => {},
});
assert.deepEqual(queryResult, {
  kind: "query",
  selector: "video",
  nodes: [{ tag: "video", id: "player" }],
});
assert.deepEqual(queried, ["video"]);

assert.equal(
  dispatchHostCall("insert", ["<i></i>", { selector: "body", position: "append" }], {
    query: () => [],
    insert: (html, opts) => {
      inserted.push({ html, selector: opts.selector });
      return [];
    },
    css: () => {},
    style: () => {},
  }).kind,
  "insert",
);
assert.equal(inserted.at(-1)?.html, "<i></i>");

assert.equal(
  dispatchHostCall("css", ["body{color:red}"], {
    query: () => [],
    insert: () => [],
    css: (text) => {
      cssWrites.push(text);
    },
    style: () => {},
  }).kind,
  "css",
);
assert.equal(cssWrites.at(-1), "body{color:red}");

const styled: Array<{
  selector: string;
  index: number;
  props: Record<string, string>;
}> = [];
assert.equal(
  dispatchHostCall(
    "style",
    [".monacle-kelp", 1, { transform: "rotate(6deg)" }],
    {
      query: () => [],
      insert: () => [],
      css: () => {},
      style: (selector, index, props) => {
        styled.push({ selector, index, props });
      },
    },
  ).kind,
  "style",
);
assert.deepEqual(styled.at(-1), {
  selector: ".monacle-kelp",
  index: 1,
  props: { transform: "rotate(6deg)" },
});

assert.equal(
  dispatchHostCall("explode", [], {
    query: () => [],
    insert: () => [],
    css: () => {},
    style: () => {},
  }).kind,
  "ignored",
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSrc = fs.readFileSync(path.join(root, "src/content/runtime.ts"), "utf8");
const contentFiles = [
  "src/content/runtime.ts",
  "src/content/sandboxFrame.ts",
  "src/content/sandboxProtocol.ts",
  "src/content/applicator.ts",
  "src/content/index.ts",
];
for (const rel of contentFiles) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  assert.equal(src.includes("new Function"), false, `${rel} must not eval`);
  assert.equal(/\beval\s*\(/.test(src), false, `${rel} must not eval`);
}
assert.ok(runtimeSrc.includes("startSandboxRuntime"));
assert.ok(runtimeSrc.includes("applyLiveStyle") || runtimeSrc.includes("style: applyLiveStyle"));
assert.ok(runtimeSrc.includes("maskPollId"));
const sandboxFrameSrc = fs.readFileSync(
  path.join(root, "src/content/sandboxFrame.ts"),
  "utf8",
);
assert.ok(sandboxFrameSrc.includes("HOST_STATE_INTERVAL_MS"));
assert.ok(sandboxFrameSrc.includes("startGeneration"));
assert.ok(sandboxFrameSrc.includes("transferCanvas"));
assert.ok(sandboxFrameSrc.includes("transferControlToOffscreen"));
const sandboxHtml = fs.readFileSync(
  path.join(root, "src/sandbox/sandbox.html"),
  "utf8",
);
assert.ok(sandboxHtml.includes("new Function"));
assert.ok(sandboxHtml.includes("monacle-raf-tick"));
assert.ok(sandboxHtml.includes("offscreenCanvas"));
assert.ok(sandboxHtml.includes("nextCanvasDim"));
assert.ok(sandboxHtml.includes("wrapOffscreen"));
assert.ok(sandboxHtml.includes("wrapQueryNode"));
assert.ok(sandboxHtml.includes('method: "style"'));
assert.equal(nextCanvasDim(1440, 1440), null);
assert.equal(nextCanvasDim(1440, 0), null);
assert.equal(nextCanvasDim(1440, -1), null);
assert.equal(nextCanvasDim(1440, Number.NaN), null);
assert.equal(nextCanvasDim(1440, 1680), 1680);
assert.equal(nextCanvasDim(1, "900"), 900);

const promptSrc = fs.readFileSync(
  path.join(root, "src/agent/systemPrompt.ts"),
  "utf8",
);
assert.equal(
  /c\.width = innerWidth; c\.height = innerHeight;/.test(promptSrc),
  false,
  "system prompt must not teach per-frame canvas resize",
);

console.log("schema tests passed");
