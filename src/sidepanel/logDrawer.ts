/**
 * Companion log panel. Hidden until the Logs button opens it.
 * Polls GET /logs while open.
 */
export function createLogDrawer(host: HTMLElement): {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setBusy: (busy: boolean) => void;
  start: (baseUrl: string) => void;
  isOpen: () => boolean;
} {
  const root = document.createElement("div");
  root.className = "log-drawer";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Companion logs");

  const pre = document.createElement("pre");
  pre.className = "log-drawer-body";
  pre.textContent = "Waiting for companion…";

  root.append(pre);
  host.append(root);

  let base = "http://127.0.0.1:8787";
  let timer: number | null = null;
  let stickBottom = true;
  let open = false;

  function syncVisibility(): void {
    host.hidden = !open;
    root.hidden = !open;
    host.classList.toggle("is-open", open);
  }

  syncVisibility();

  pre.addEventListener("scroll", () => {
    const slack = 24;
    stickBottom =
      pre.scrollTop + pre.clientHeight >= pre.scrollHeight - slack;
  });

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/logs`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        text?: string;
        lines?: string[];
      };
      const text =
        data.text ||
        (data.lines || []).join("\n") ||
        "No log lines yet. Send a restyle.";
      pre.textContent = text;
      if (stickBottom) pre.scrollTop = pre.scrollHeight;
    } catch {
      pre.textContent =
        "Companion not reachable. In the repo: npm run dev";
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

  function setOpen(next: boolean): void {
    open = next;
    syncVisibility();
    if (open) {
      stickBottom = true;
      startPoll();
    } else {
      stopPoll();
    }
  }

  return {
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle() {
      setOpen(!open);
    },
    setBusy(_next: boolean) {
      // Stay closed until the user opens the panel.
    },
    start(baseUrl: string) {
      if (baseUrl) base = baseUrl;
      void refresh();
    },
    isOpen() {
      return open;
    },
  };
}
