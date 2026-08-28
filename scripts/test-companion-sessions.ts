import assert from "node:assert/strict";
import {
  SessionError,
  activeCount,
  beginRun,
  configure,
  endRun,
  ingestPayload,
  ingestStep,
  ingestThinking,
  listSnapshots,
  maxConcurrent,
  resetForTests,
  snapshot,
} from "./companion-sessions.mjs";

resetForTests();
configure({ maxConcurrent: 3 });
assert.equal(maxConcurrent(), 3);
assert.equal(activeCount(), 0);

const side = beginRun({
  sessionId: "sess_manual",
  source: "sidepanel",
  prompt: "cinema",
});
const loop = beginRun({
  sessionId: "sess_loop",
  source: "loop",
  prompt: "ocean",
});
assert.equal(side.id, "sess_manual");
assert.equal(loop.id, "sess_loop");
assert.equal(activeCount(), 2);

ingestStep("sess_manual", "Writing restyle patch…");
ingestPayload("sess_manual", '{ "css": "body{color:red}" }');
ingestStep("sess_loop", "→ Read snapshot");
ingestThinking("sess_loop", "coral and fish");

const manualSnap = snapshot("sess_manual");
assert.equal(manualSnap.running, true);
assert.equal(manualSnap.source, "sidepanel");
assert.ok(manualSnap.lines.some((l: string) => l.includes("Writing restyle")));
assert.ok(!manualSnap.lines.some((l: string) => l.includes("body{color:red}")));
assert.equal(manualSnap.hasPayload, true);
assert.ok(String(manualSnap.payload).includes("body{color:red}"));
assert.ok(!manualSnap.lines.some((l: string) => l.includes("Read snapshot")));

const loopSnap = snapshot("sess_loop");
assert.ok(loopSnap.lines.some((l: string) => l.includes("Read snapshot")));
assert.ok(loopSnap.lines.some((l: string) => l.includes("coral")));
assert.equal(loopSnap.thinking, "coral and fish");
assert.ok(!loopSnap.lines.some((l: string) => l.includes("Writing restyle")));

const all = snapshot();
assert.equal(all.running, true);
assert.equal(all.count, 2);
assert.equal(all.summary, "2 agents running");
assert.ok(all.lines.some((l: string) => l.startsWith("[sidepanel]")));
assert.ok(all.lines.some((l: string) => l.startsWith("[loop]")));

assert.throws(
  () =>
    beginRun({
      sessionId: "sess_manual",
      source: "sidepanel",
      prompt: "again",
    }),
  (err: unknown) => err instanceof SessionError && err.status === 409,
);

const seq = beginRun({
  sessionId: "sess_sequence",
  source: "sequence",
  prompt: "youtube",
});
assert.equal(activeCount(), 3);
assert.throws(
  () => beginRun({ sessionId: "sess_overflow", source: "loop" }),
  (err: unknown) => err instanceof SessionError && err.status === 429,
);

endRun(seq.id);
assert.equal(activeCount(), 2);

endRun("sess_manual");
const reused = beginRun({
  sessionId: "sess_manual",
  source: "sidepanel",
  prompt: "retry",
});
assert.equal(reused.id, "sess_manual");
assert.equal(activeCount(), 2);

endRun("sess_manual");
endRun("sess_loop");
assert.equal(activeCount(), 0);
assert.equal(listSnapshots().length >= 2, true);

const missing = snapshot("does-not-exist");
assert.equal(missing.running, false);
assert.equal(missing.sessionId, "does-not-exist");

resetForTests();
console.log("companion-sessions: ok");
