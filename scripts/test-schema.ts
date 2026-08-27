import assert from "node:assert/strict";
import {
  extractCodeFromText,
  extractPatchFromText,
  isRuntimeSourceAllowed,
  patchFromRuntimeCode,
  validatePatch,
} from "../src/patches/schema";
import { CINEMA_DEMO_PATCH } from "../src/patches/cinemaDemo";

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

console.log("schema tests passed");
