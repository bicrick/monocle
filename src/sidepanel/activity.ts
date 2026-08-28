import {
  idleActivityTitle,
  interpretActivityLine,
} from "../shared/activityTalk";
import type { ActivityLine } from "../shared/types";
import { syncActivityItem } from "./activityItem";
import { createTextShimmer } from "./textShimmer";

/**
 * Cursor-style thought block: header + shimmer verb + live talk line.
 * Expand to see the full chronological history.
 */
export function createActivityBlock(): {
  root: HTMLElement;
  setBusy: (busy: boolean) => void;
  setLines: (lines: ActivityLine[]) => void;
  push: (line: ActivityLine) => void;
  updateLast: (line: ActivityLine) => void;
  clear: () => void;
  /** Mount (or remount) into the transcript flow after the latest user message. */
  mountInto: (parent: HTMLElement) => void;
} {
  const root = document.createElement("details");
  root.className = "activity";
  root.hidden = true;

  const summary = document.createElement("summary");
  summary.className = "activity-summary";

  const heading = document.createElement("span");
  heading.className = "activity-heading";

  const title = document.createElement("span");
  title.className = "activity-title";
  title.textContent = "Thinking";

  const caret = document.createElement("span");
  caret.className = "activity-caret";
  caret.setAttribute("aria-hidden", "true");

  heading.append(title, caret);

  const status = document.createElement("span");
  status.className = "activity-status";
  status.hidden = true;

  const talk = document.createElement("span");
  talk.className = "activity-talk";
  talk.hidden = true;

  summary.append(heading, status, talk);

  const list = document.createElement("ol");
  list.className = "activity-log";

  root.append(summary, list);

  const lines: ActivityLine[] = [];
  let startedAt: number | null = null;
  let wantBusy = false;
  let statusVerb = "";

  function syncTitle(busy: boolean): void {
    const next = busy ? "Thinking" : idleActivityTitle(lines, startedAt);
    if (title.textContent !== next) title.textContent = next;
  }

  /** Shimmer on a short verb. Recreate the node only when the verb changes. */
  function syncStatus(busy: boolean, verb: string): void {
    if (!busy || !verb) {
      status.hidden = true;
      status.replaceChildren();
      statusVerb = "";
      return;
    }
    status.hidden = false;
    if (verb === statusVerb && status.firstElementChild) return;
    statusVerb = verb;
    status.replaceChildren(createTextShimmer(verb));
  }

  /** Non-animated thought/step. Safe to update every poll. */
  function syncTalk(busy: boolean, text: string, verb: string): void {
    if (!busy || !text) {
      talk.hidden = true;
      talk.textContent = "";
      return;
    }
    const sameAsVerb = text === verb || text.toLowerCase() === verb.toLowerCase();
    if (sameAsVerb) {
      talk.hidden = true;
      talk.textContent = "";
      return;
    }
    talk.hidden = false;
    if (talk.textContent !== text) talk.textContent = text;
  }

  function syncHistory(): void {
    while (list.children.length > lines.length) {
      list.lastElementChild?.remove();
    }
    for (let i = 0; i < lines.length; i++) {
      let item = list.children[i] as HTMLLIElement | undefined;
      if (!item) {
        item = document.createElement("li");
        list.append(item);
      }
      syncActivityItem(item, lines[i]);
    }
  }

  function render(): void {
    const last = lines[lines.length - 1];
    const busy = wantBusy;
    const errored = last?.state === "error" && !busy;
    const mapped = last ? interpretActivityLine(last) : null;

    root.classList.toggle("is-busy", busy);
    root.classList.toggle("is-error", errored);

    syncTitle(busy);
    syncStatus(busy, mapped?.verb ?? "");
    syncTalk(busy, mapped?.talk ?? "", mapped?.verb ?? "");
    syncHistory();
  }

  return {
    root,
    mountInto(parent: HTMLElement) {
      const users = parent.querySelectorAll(".msg.user");
      const lastUser = users[users.length - 1] as HTMLElement | undefined;
      if (lastUser) {
        lastUser.after(root);
        return;
      }
      parent.append(root);
    },
    setBusy(busy: boolean) {
      wantBusy = busy;
      if (busy) {
        root.hidden = false;
        if (startedAt == null) startedAt = Date.now();
      }
      render();
    },
    setLines(next: ActivityLine[]) {
      lines.splice(0, lines.length, ...next.slice(-24));
      root.hidden = lines.length === 0 && !wantBusy;
      if (wantBusy && startedAt == null) {
        startedAt = lines.find((l) => l.state === "active")?.ts ?? Date.now();
      }
      render();
    },
    push(line: ActivityLine) {
      const prev = lines[lines.length - 1];
      if (prev?.state === "active") prev.state = "done";
      lines.push(line);
      if (lines.length > 24) lines.splice(0, lines.length - 24);
      root.hidden = false;
      if (line.state === "active" && startedAt == null) {
        startedAt = line.ts || Date.now();
      }
      render();
    },
    updateLast(line: ActivityLine) {
      const prev = lines[lines.length - 1];
      if (prev && prev.label === line.label) {
        prev.detail = line.detail;
        prev.ts = line.ts;
        prev.state = line.state;
        prev.thinking = line.thinking;
      } else {
        if (prev?.state === "active") prev.state = "done";
        lines.push(line);
        if (lines.length > 24) lines.splice(0, lines.length - 24);
        root.hidden = false;
        if (line.state === "active" && startedAt == null) {
          startedAt = line.ts || Date.now();
        }
      }
      render();
    },
    clear() {
      lines.length = 0;
      startedAt = null;
      wantBusy = false;
      statusVerb = "";
      status.hidden = true;
      status.replaceChildren();
      talk.hidden = true;
      talk.textContent = "";
      root.hidden = true;
      root.open = false;
      render();
    },
  };
}
