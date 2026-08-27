import type { ActivityLine } from "../shared/types";

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

/**
 * Cursor-style thought block: lives in the transcript under the user turn.
 * Collapsed: "Thought for Ns" / "Thinking…". Expand for abstracted steps.
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
  summary.innerHTML = `
    <span class="activity-title">Thinking…</span>
  `;

  const list = document.createElement("ol");
  list.className = "activity-log";

  root.append(summary, list);

  const lines: ActivityLine[] = [];
  let startedAt: number | null = null;
  let timer: number | null = null;

  function stopTimer(): void {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function render(): void {
    const title = summary.querySelector(".activity-title");
    const last = lines[lines.length - 1];
    const busy = lines.some((l) => l.state === "active");

    if (title) {
      if (busy && startedAt != null) {
        title.textContent = `Thinking… ${formatDuration(Date.now() - startedAt)}`;
      } else if (last?.state === "error") {
        title.textContent = "Failed";
      } else if (startedAt != null) {
        title.textContent = `Thought for ${formatDuration(Date.now() - startedAt)}`;
      } else {
        title.textContent = "Thought";
      }
    }

    root.classList.toggle("is-busy", busy);
    root.classList.toggle("is-error", last?.state === "error" && !busy);
    if (busy || last?.state === "error") root.open = true;

    const prevLog = list.querySelector(
      ".activity-item-log",
    ) as HTMLElement | null;
    const stick =
      !prevLog ||
      prevLog.scrollTop + prevLog.clientHeight >= prevLog.scrollHeight - 16;

    list.replaceChildren();
    for (const line of lines) {
      const item = document.createElement("li");
      item.className = `activity-item is-${line.state}`;
      const label = document.createElement("span");
      label.className = "activity-item-label";
      label.textContent = line.label;
      item.append(label);
      if (line.detail) {
        const detail = document.createElement("pre");
        const isCli = line.label === "Asking Cursor";
        detail.className = isCli
          ? "activity-item-detail activity-item-log"
          : "activity-item-detail";
        detail.textContent = line.detail;
        item.append(detail);
        if (isCli && stick) {
          requestAnimationFrame(() => {
            detail.scrollTop = detail.scrollHeight;
          });
        }
      }
      list.append(item);
    }
  }

  return {
    root,
    mountInto(parent: HTMLElement) {
      // Keep the thought block under the latest user turn (before assistant).
      // Re-appending to the end after streaming starts buries it below the reply.
      const users = parent.querySelectorAll(".msg.user");
      const lastUser = users[users.length - 1] as HTMLElement | undefined;
      if (lastUser) {
        lastUser.after(root);
        return;
      }
      parent.append(root);
    },
    setBusy(busy: boolean) {
      root.classList.toggle("is-busy", busy);
      if (busy) {
        root.hidden = false;
        if (startedAt == null) startedAt = Date.now();
        stopTimer();
        timer = window.setInterval(render, 1000);
      } else {
        stopTimer();
      }
      render();
    },
    setLines(next: ActivityLine[]) {
      lines.splice(0, lines.length, ...next.slice(-24));
      root.hidden = lines.length === 0;
      const busy = lines.some((l) => l.state === "active");
      if (busy && startedAt == null) {
        startedAt = lines.find((l) => l.state === "active")?.ts ?? Date.now();
      }
      if (!busy) stopTimer();
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
        stopTimer();
        timer = window.setInterval(render, 1000);
      }
      if (line.state === "done" || line.state === "error") {
        if (!lines.some((l) => l.state === "active")) stopTimer();
      }
      render();
    },
    updateLast(line: ActivityLine) {
      const prev = lines[lines.length - 1];
      if (prev && prev.label === line.label) {
        prev.detail = line.detail;
        prev.ts = line.ts;
        prev.state = line.state;
      } else {
        lines.push(line);
        if (lines.length > 24) lines.splice(0, lines.length - 24);
        root.hidden = false;
      }
      render();
    },
    clear() {
      lines.length = 0;
      startedAt = null;
      stopTimer();
      root.hidden = true;
      render();
    },
  };
}
