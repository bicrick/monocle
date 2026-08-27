/**
 * Quiet green connection pill in the composer toolbar (Cursor model-selector style).
 */
export function createStatusChip(
  host: HTMLElement,
  onClick?: () => void,
): {
  setOnline: (online: boolean) => void;
  start: (baseUrl: string) => void;
  stop: () => void;
} {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "conn-chip";
  chip.title = "Open companion logs";
  chip.innerHTML = `
    <span class="conn-dot" aria-hidden="true"></span>
    <span class="conn-label">CLI</span>
  `;
  host.append(chip);
  if (onClick) {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
  }

  let timer: number | null = null;
  let base = "http://127.0.0.1:8787";

  async function ping(): Promise<void> {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/health`, {
        method: "GET",
      });
      chip.classList.toggle("is-online", res.ok);
      chip.classList.toggle("is-offline", !res.ok);
      chip.title = res.ok
        ? "Companion connected — click for logs"
        : "Companion not responding — run npm run dev";
    } catch {
      chip.classList.remove("is-online");
      chip.classList.add("is-offline");
      chip.title = "Companion offline — run npm run dev";
    }
  }

  return {
    setOnline(online: boolean) {
      chip.classList.toggle("is-online", online);
      chip.classList.toggle("is-offline", !online);
    },
    start(baseUrl: string) {
      base = baseUrl || base;
      void ping();
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(() => void ping(), 8000);
    },
    stop() {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    },
  };
}
