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
import {
  CANVAS_LONG_SIDE_CAP,
  capCanvasSize,
  nextCanvasDim,
} from "../src/sandbox/safeCanvasDim";
import {
  RAF_ERROR_LIMIT,
  nextErrorStreak,
  shouldSkipFrame,
  shouldTripBreaker,
} from "../src/sandbox/runtimeGuard";
import { unsupportedRuntimeReason } from "../src/sandbox/runtimePolicy";
import { errorMessage, isolate, isolateVoid } from "../src/content/isolate";

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
  isRuntimeSourceAllowed("const gl = c.getContext('webgl')"),
  true,
  "webgl must not void the whole patch — runtime layer rejects it",
);

assert.match(
  unsupportedRuntimeReason("const gl = c.getContext('webgl')") || "",
  /WebGL/i,
);
assert.match(
  unsupportedRuntimeReason("new THREE.WebGLRenderer({ canvas: c })") || "",
  /Three\.js|WebGL/i,
);
assert.match(
  unsupportedRuntimeReason(
    "s.src='https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js'",
  ) || "",
  /CDN/i,
);
assert.equal(
  unsupportedRuntimeReason("const ctx = c.getContext('2d')"),
  "monacle.canvas() / getContext('2d') are disabled. Use monacle.create() for DOM motion.",
);
assert.match(
  unsupportedRuntimeReason("const c = monacle.canvas()") || "",
  /monacle\.canvas|disabled|create/i,
);
assert.equal(
  unsupportedRuntimeReason("monacle.three.add({ id:'moon', kind:'sphere' })"),
  null,
  "monacle.three host API must be allowed",
);
assert.equal(
  unsupportedRuntimeReason("monacle.create('<div></div>')"),
  null,
);
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
const created: Array<{ html: string; opts?: unknown }> = [];
const cssWrites: string[] = [];

const emptyHandlers = {
  query: () => [] as unknown[],
  insert: () => [] as unknown[],
  create: () => [] as unknown[],
  css: () => {},
  style: () => {},
  three: {
    clear: () => {},
    setBackground: () => {},
    add: () => {},
    update: () => {},
    remove: () => {},
    camera: () => {},
    lights: () => {},
    ensure: () => {},
  },
};

const queryResult = dispatchHostCall("query", ["video"], {
  ...emptyHandlers,
  query: (selector) => {
    queried.push(selector);
    return [{ tag: "video", id: "player" }];
  },
});
assert.deepEqual(queryResult, {
  kind: "query",
  selector: "video",
  nodes: [{ tag: "video", id: "player" }],
});
assert.deepEqual(queried, ["video"]);

const insertResult = dispatchHostCall(
  "insert",
  ["<i></i>", { selector: "body", position: "append", batchId: "b1" }],
  {
    ...emptyHandlers,
    insert: (html, opts) => {
      inserted.push({ html, selector: opts.selector });
      return [{ tag: "i", id: "", className: "", rect: { x: 0, y: 0, width: 0, height: 0 } }];
    },
  },
);
assert.equal(insertResult.kind, "insert");
if (insertResult.kind === "insert") {
  assert.equal(insertResult.selector, '[data-monacle-batch="b1"]');
  assert.equal(insertResult.nodes.length, 1);
}
assert.equal(inserted.at(-1)?.html, "<i></i>");

const createResult = dispatchHostCall(
  "create",
  ['<div class="fish"></div>', { batchId: "b2" }],
  {
    ...emptyHandlers,
    create: (html, opts) => {
      created.push({ html, opts });
      return [
        { tag: "div", id: "", className: "fish", rect: { x: 0, y: 0, width: 0, height: 0 } },
      ];
    },
  },
);
assert.equal(createResult.kind, "create");
if (createResult.kind === "create") {
  assert.equal(createResult.selector, '[data-monacle-batch="b2"]');
  assert.equal(createResult.nodes.length, 1);
}
assert.equal(created.at(-1)?.html, '<div class="fish"></div>');

const threeCmds: string[] = [];
assert.equal(
  dispatchHostCall("three", ["add", { id: "moon", kind: "sphere" }], {
    ...emptyHandlers,
    three: {
      ...emptyHandlers.three,
      add: (spec) => {
        threeCmds.push(`add:${String(spec.id)}`);
      },
    },
  }).kind,
  "three",
);
assert.deepEqual(threeCmds, ["add:moon"]);

assert.equal(
  dispatchHostCall("css", ["body{color:red}"], {
    ...emptyHandlers,
    css: (text) => {
      cssWrites.push(text);
    },
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
      ...emptyHandlers,
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

assert.equal(dispatchHostCall("explode", [], emptyHandlers).kind, "ignored");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSrc = fs.readFileSync(path.join(root, "src/content/runtime.ts"), "utf8");
const contentFiles = [
  "src/content/runtime.ts",
  "src/content/sandboxFrame.ts",
  "src/content/sandboxProtocol.ts",
  "src/content/applicator.ts",
  "src/content/index.ts",
  "src/content/runtimeErrors.ts",
  "src/content/isolate.ts",
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
assert.ok(
  sandboxFrameSrc.includes("frameIsUsable") &&
    sandboxFrameSrc.includes("stopSandboxSession"),
  "sandboxFrame must reuse the iframe across restyles (avoid GPU crash thrash)",
);
assert.equal(
  sandboxFrameSrc.includes("transferControlToOffscreen"),
  false,
  "sandboxFrame must not transfer OffscreenCanvas",
);
assert.equal(
  sandboxFrameSrc.includes("transferCanvas"),
  false,
  "sandboxFrame must not transfer canvas",
);
const sandboxHtml = fs.readFileSync(
  path.join(root, "src/sandbox/sandbox.html"),
  "utf8",
);
assert.ok(sandboxHtml.includes("new Function"));
assert.ok(sandboxHtml.includes("monacle-raf-tick"));
assert.ok(sandboxHtml.includes("createOnHost") || sandboxHtml.includes('method: "create"'));
assert.ok(sandboxHtml.includes("monacle.create") || sandboxHtml.includes("create: function"));
assert.ok(sandboxHtml.includes("wrapQueryNode"));
assert.ok(sandboxHtml.includes('method: "style"'));
assert.ok(sandboxHtml.includes("noteCallbackError"));
assert.ok(sandboxHtml.includes("unhandledrejection"));
assert.ok(sandboxHtml.includes('addEventListener("error"'));
assert.ok(sandboxHtml.includes("nativeSetTimeout"));
assert.ok(sandboxHtml.includes("FRAME_BUDGET_MS"));
assert.ok(sandboxHtml.includes("skipNextFrame"));
assert.ok(sandboxHtml.includes("monacle.canvas() is disabled"));
assert.equal(
  sandboxHtml.includes("offscreenCanvas"),
  false,
  "sandbox must not use OffscreenCanvas",
);
assert.equal(
  sandboxHtml.includes("transferControlToOffscreen"),
  false,
);
assert.ok(sandboxFrameSrc.includes("noteDeadFrame"));
assert.ok(sandboxFrameSrc.includes("reportRuntimeError"));
const applicatorSrc = fs.readFileSync(
  path.join(root, "src/content/applicator.ts"),
  "utf8",
);
assert.ok(applicatorSrc.includes("ApplyPatchResult"));
assert.ok(applicatorSrc.includes("applyOpSafe"));
assert.ok(applicatorSrc.includes("runtimeStarted"));
assert.ok(applicatorSrc.includes("monacle-scene"));
assert.ok(runtimeSrc.includes("ensureSceneRoot") || runtimeSrc.includes("SCENE_ID") || runtimeSrc.includes("monacle-scene"));
assert.ok(runtimeSrc.includes("createHtml") || runtimeSrc.includes("create:"));
const typesSrc = fs.readFileSync(path.join(root, "src/shared/types.ts"), "utf8");
assert.ok(typesSrc.includes("RUNTIME_ERROR"));
assert.ok(typesSrc.includes("opErrors"));
assert.ok(typesSrc.includes("lastRuntimeError"));
const bgSrc = fs.readFileSync(
  path.join(root, "src/background/index.ts"),
  "utf8",
);
assert.ok(bgSrc.includes("maybeStartRepair"));
assert.ok(bgSrc.includes("RUNTIME_ERROR"));
assert.ok(bgSrc.includes("unhandledrejection"));
assert.ok(!bgSrc.includes("fewer particles"));
assert.equal(isolate(() => { throw new Error("boom"); }, 0).error, "boom");
assert.equal(isolate(() => 7, 0).value, 7);
assert.equal(isolateVoid(() => { throw new TypeError("bad op"); }), "bad op");
assert.equal(isolateVoid(() => undefined), null);
assert.equal(errorMessage(new Error("x")), "x");

assert.equal(nextCanvasDim(1440, 1440), null);
assert.equal(nextCanvasDim(1440, 0), null);
assert.equal(nextCanvasDim(1440, -1), null);
assert.equal(nextCanvasDim(1440, Number.NaN), null);
assert.equal(nextCanvasDim(1440, 1680), 1680);
assert.equal(nextCanvasDim(1, "900"), 900);
assert.deepEqual(capCanvasSize(1280, 720), { width: 1280, height: 720 });
assert.deepEqual(capCanvasSize(1920, 1080), {
  width: CANVAS_LONG_SIDE_CAP,
  height: Math.round((1080 * CANVAS_LONG_SIDE_CAP) / 1920),
});
assert.equal(nextErrorStreak(0, true), 1);
assert.equal(nextErrorStreak(2, true), 3);
assert.equal(nextErrorStreak(2, false), 0);
assert.equal(shouldTripBreaker(2), false);
assert.equal(shouldTripBreaker(RAF_ERROR_LIMIT), true);
assert.equal(shouldSkipFrame(16), false);
assert.equal(shouldSkipFrame(17), true);

const promptSrc = fs.readFileSync(
  path.join(root, "src/agent/systemPrompt.ts"),
  "utf8",
);
assert.equal(
  /c\.width = innerWidth; c\.height = innerHeight;/.test(promptSrc),
  false,
  "system prompt must not teach per-frame canvas resize",
);
assert.match(promptSrc, /Do NOT load CDN Three|Do NOT call new THREE\.WebGLRenderer/i);
assert.match(promptSrc, /monacle\.create/);
assert.match(promptSrc, /monacle\.three/);
assert.match(promptSrc, /DISABLED|disabled/);
assert.equal(
  /Prefer canvas 2d|fake depth with layered DOM, gradients, particles as divs, parallax via style — never real WebGL/i.test(
    promptSrc,
  ),
  false,
  "system prompt must teach monacle.three for 3D, not fake-only DOM",
);
assert.match(promptSrc, /always null/i);
assert.ok(sandboxHtml.includes("CREATE_CHILD_CAP") || sandboxHtml.includes("createOnHost"));
assert.ok(sandboxHtml.includes("threeCall") || sandboxHtml.includes("monacle.three") || sandboxHtml.includes('method: "three"'));
const policySrc = fs.readFileSync(
  path.join(root, "src/sandbox/runtimePolicy.ts"),
  "utf8",
);
assert.ok(policySrc.includes("unsupportedRuntimeReason"));
assert.ok(policySrc.includes("monacle.three") || policySrc.includes("CANVAS_API_RE"));
const runtimeSrcAfter = fs.readFileSync(
  path.join(root, "src/content/runtime.ts"),
  "utf8",
);
assert.ok(runtimeSrcAfter.includes("unsupportedRuntimeReason"));
assert.ok(runtimeSrcAfter.includes("ensureSceneRoot"));
assert.ok(runtimeSrcAfter.includes("buildThreeApi") || runtimeSrcAfter.includes("three:"));
const threeHostSrc = fs.readFileSync(
  path.join(root, "src/content/threeHost.ts"),
  "utf8",
);
assert.ok(threeHostSrc.includes("INJECT_THREE_STAGE"));
assert.ok(threeHostSrc.includes("monacle-three-host"));
const threeStageSrc = fs.readFileSync(
  path.join(root, "src/page/threeStage.ts"),
  "utf8",
);
assert.ok(threeStageSrc.includes("WebGLRenderer"));
assert.ok(threeStageSrc.includes("CANVAS_LONG_SIDE_CAP"));
const viteSrc = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
assert.ok(viteSrc.includes("preserveSandboxHtml"));
const preservePlugin = fs.readFileSync(
  path.join(root, "scripts/preserve-sandbox-plugin.mjs"),
  "utf8",
);
assert.ok(preservePlugin.includes("CRXJS DEV MODE"));
assert.ok(preservePlugin.includes("monacle-runtime-start"));
const manifestSrc = fs.readFileSync(path.join(root, "manifest.config.ts"), "utf8");
assert.ok(manifestSrc.includes("threeStage.js"));

console.log("schema tests passed");
