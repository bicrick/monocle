import assert from "node:assert/strict";
import {
  formatCss,
  formatHtml,
  parseActivityDetail,
} from "../src/sidepanel/activityDetail";
import { createStreamParser } from "./cli-stream.mjs";
import {
  beginRun,
  ingestPayload,
  resetForTests,
  snapshot,
} from "./companion-sessions.mjs";

const complete = parseActivityDetail(`Working… 23s
Writing restyle patch…
{
  "message": "Dimmed room",
  "css": "html[data-monacle=on] footer { opacity: .55 !important; }",
  "overlayHtml": "<div style=\\"position:fixed;inset:0\\"><span>glow</span></div>",
  "ops": [{ "type": "hide", "selector": "#secondary" }],
  "runtime": "monacle.raf(() => {})"
}`);

assert.deepEqual(complete.steps, ["Working… 23s", "Writing restyle patch…"]);
assert.equal(complete.fallback, null);
const byKey = Object.fromEntries(complete.fields.map((f) => [f.key, f]));
assert.equal(byKey.message.value, "Dimmed room");
assert.match(byKey.css.value, /footer \{/);
assert.match(byKey.css.value, /opacity: \.55 !important;/);
assert.equal(byKey.css.value.includes("\\"), false);
assert.match(byKey.overlayHtml.value, /<div style="position:fixed;inset:0">/);
assert.doesNotMatch(byKey.overlayHtml.value, /\\"/);
assert.match(byKey.overlayHtml.value, /<span>/);
assert.match(byKey.overlayHtml.value, /glow/);
assert.equal(byKey.ops.value, "hide  #secondary");
assert.equal(byKey.runtime.value, "monacle.raf(() => {})");

const fragment = parseActivityDetail(`Working… 23s
on] .App_nav, html[data-monacle=on] footer { opacity: .55 !important; filter: saturate(.6) brightness(.85); }",
"overlayHtml": "<div style=\\"position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 90% 55% at 50% -8%,rgba(30,55,90,.35),transparent 58%)\\"></div>"`);

assert.deepEqual(fragment.steps, ["Working… 23s"]);
const frag = Object.fromEntries(fragment.fields.map((f) => [f.key, f]));
assert.ok(frag.overlayHtml);
assert.match(frag.overlayHtml.value, /position:fixed/);
assert.doesNotMatch(frag.overlayHtml.value, /\\"/);
assert.ok(frag.css);
assert.match(frag.css.value, /footer/);
assert.match(frag.css.value, /opacity: \.55 !important;/);
assert.doesNotMatch(frag.css.value, /overlayHtml/);

const plain = parseActivityDetail("bicrick\nhttps://www.bicrick.com/about");
assert.equal(plain.fallback, "bicrick\nhttps://www.bicrick.com/about");
assert.equal(plain.fields.length, 0);

const stepsOnly = parseActivityDetail("Working… 4s\nThinking: coral and fish");
assert.deepEqual(stepsOnly.steps, [
  "Working… 4s",
  "Thinking: coral and fish",
]);
assert.equal(stepsOnly.fields.length, 0);
assert.equal(stepsOnly.fallback, null);

assert.equal(
  formatCss("a, b { color: red; opacity: .5; }"),
  "a, b {\n  color: red;\n  opacity: .5;\n}",
);
assert.equal(
  formatHtml('<div style="x"><span>y</span></div>'),
  "<div style=\"x\">\n  <span>\n    y\n  </span>\n</div>",
);

const steps: string[] = [];
const payloads: string[] = [];
const parser = createStreamParser({
  onStep: (line: string) => steps.push(line),
  onPayload: (text: string) => payloads.push(text),
});
parser.push(
  `${JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: '{ "css": "body{color:red}"' }],
    },
  })}\n`,
);
parser.push(
  `${JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: ', "overlayHtml": "<div style=\\"x\\"></div>" }',
        },
      ],
    },
  })}\n`,
);
assert.equal(
  steps.filter((s) => s === "Writing restyle patch…").length,
  1,
);
assert.ok(!steps.some((s) => s.includes("overlayHtml")));
assert.equal(payloads.length, 2);
assert.ok(payloads.at(-1)?.includes("overlayHtml"));
assert.ok(payloads.at(-1)?.includes("body{color:red}"));

const sidParser = createStreamParser({});
sidParser.push(
  `${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    session_id: "abc-resume-id-123",
  })}\n`,
);
sidParser.flush();
assert.equal(sidParser.cursorSessionId(), "abc-resume-id-123");

resetForTests();
beginRun({ sessionId: "sess_payload", source: "sidepanel", prompt: "ocean" });
ingestPayload(
  "sess_payload",
  '{ "css": "footer{opacity:.55}", "overlayHtml": "<div></div>" }',
);
const snap = snapshot("sess_payload");
assert.ok(snap.lines.some((l: string) => l.includes("overlayHtml")));
assert.ok(snap.lines.some((l: string) => l.includes("Thinking…")));
resetForTests();

console.log("activity-detail: ok");
