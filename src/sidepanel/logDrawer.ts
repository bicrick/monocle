/**
 * Live companion log drawer. Polls GET /logs while open.
 */
export function createLogDrawer(host: HTMLElement): {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setBusy: (busy: boolean) => void;
  start: (baseUrl: string) => void;
  isOpen: () => boolean;
} {
  const root = document.createElement("details");
  root.className = "log-drawer";

  const summary = document.createElement("summary");
  summary.className = "log-drawer-summary";
  summary.innerHTML = `
    <span class="log-drawer-title">Companion logs</span>
    <span class="log-drawer-path"></span>
  `;

  const pre = document.createElement("pre");
  pre.className = "log-drawer-body";
  pre.textContent = "Waiting for companion…";

  root.append(summary, pre);
  host.append(root);

  let base = "http://127.0.0.1:8787";
  let timer: number | null = null;
  let stickBottom = true;
  let userClosedThisRun = false;
  let busy = false;

  pre.addEventListener("scroll", () => {
    const slack = 24;
    stickBottom =
      pre.scrollTop + pre.clientHeight >= pre.scrollHeight - slack;
  });

  async function refresh(): Promise<void> {
    const pathEl = summary.querySelector(".log-drawer-path");
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/logs`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        logPath?: string;
        text?: string;
        lines?: string[];
      };
      if (pathEl) {
        pathEl.textContent = data.logPath
          ? data.logPath.replace(/^.*\/(logs\/)/, "$1")
          : "";
        pathEl.title = data.logPath || "";
      }
      const text =
        data.text ||
        (data.lines || []).join("\n") ||
        "No log lines yet. Send a restyle.";
      pre.textContent = text;
      if (stickBottom) pre.scrollTop = pre.scrollHeight;
    } catch {
      if (pathEl) pathEl.textContent = "";
      pre.textContent =
        "Companion not reachable. In the repo: npm run companion";
    }
  }

  function startPoll(): void {
    if (timer != null) return;
    void refresh();
    timer = window.setInterval(() => void refresh(), 800);
  }

  function stopPoll(): void {
    if (timer == null) return;
    window.clearInterval(timer);
    timer = null;
  }

  root.addEventListener("toggle", () => {
    if (root.open) {
      userClosedThisRun = false;
      stickBottom = true;
      startPoll();
    } else {
      if (busy) userClosedThisRun = true;
      stopPoll();
    }
  });

  return {
    open() {
      root.open = true;
      startPoll();
    },
    close() {
      root.open = false;
      stopPoll();
    },
    toggle() {
      if (root.open) {
        root.open = false;
        stopPoll();
        if (busy) userClosedThisRun = true;
        return;
      }
      root.open = true;
      userClosedThisRun = false;
      startPoll();
    },
    setBusy(next: boolean) {
      busy = next;
      if (next && !userClosedThisRun) {
        root.open = true;
        startPoll();
      }
      if (!next) userClosedThisRun = false;
    },
    start(baseUrl: string) {
      if (baseUrl) base = baseUrl;
    },
    isOpen() {
      return root.open;
    },
  };
}
