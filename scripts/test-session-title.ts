import assert from "node:assert/strict";
import {
  displaySessionTitle,
  isBlankTitle,
  isJunkTitle,
  isOpenableUrl,
  visibleSessions,
} from "../src/sidepanel/sessionTitle.ts";
import type { SessionSummary } from "../src/shared/types.ts";

assert.equal(isBlankTitle("New chat"), true);
assert.equal(isBlankTitle("  untitled chat  "), true);
assert.equal(isBlankTitle("Show me light mode"), false);

assert.equal(isJunkTitle("https://www.bicrick.com"), true);
assert.equal(isJunkTitle("Restyle this page"), false);

assert.equal(isOpenableUrl("https://www.bicrick.com/about"), true);
assert.equal(isOpenableUrl("http://localhost:5173/"), true);
assert.equal(isOpenableUrl("chrome://extensions"), false);
assert.equal(isOpenableUrl("about:blank"), false);
assert.equal(isOpenableUrl("not a url"), false);

function row(
  partial: Partial<SessionSummary> & Pick<SessionSummary, "id" | "title">,
): SessionSummary {
  return {
    pageTitle: "",
    url: "",
    urlKey: "",
    updatedAt: 0,
    host: "",
    ...partial,
  };
}

assert.equal(
  displaySessionTitle(
    row({
      id: "a",
      title: "Show me light mode here.",
      host: "hebecom.atlassian.net",
    }),
  ),
  "Show me light mode here.",
);
assert.equal(
  displaySessionTitle(
    row({ id: "b", title: "New chat", pageTitle: "About", host: "www.bicrick.com" }),
  ),
  "About",
);
assert.equal(
  displaySessionTitle(row({ id: "c", title: "New chat", host: "www.nytimes.com" })),
  "www.nytimes.com",
);

const visible = visibleSessions(
  [
    row({ id: "keep", title: "bicrick" }),
    row({ id: "shell", title: "New chat" }),
  ],
  "active-other",
);
assert.deepEqual(
  visible.map((s) => s.id),
  ["keep"],
);

const withActiveShell = visibleSessions(
  [row({ id: "shell", title: "New chat" })],
  "shell",
);
assert.equal(withActiveShell.length, 1);
assert.equal(withActiveShell[0].id, "shell");

console.log("session-title: ok");
