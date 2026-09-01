import type { SessionSummary } from "../shared/types";
import {
  displaySessionTitle,
  isOpenableUrl,
  relativeTime,
  visibleSessions,
} from "./sessionTitle";

export function createHistoryPanel(opts: {
  app: HTMLElement;
  toggle: HTMLButtonElement;
  panel: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  titleBtn: HTMLButtonElement;
  stage: HTMLElement;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenPage: (url: string) => void;
}): {
  render: (sessions: SessionSummary[], activeId: string | null) => void;
  close: () => void;
  isOpen: () => boolean;
} {
  let open = false;
  let active: SessionSummary | null = null;

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    opts.app.classList.toggle("is-history-open", next);
    opts.toggle.setAttribute("aria-expanded", next ? "true" : "false");
    opts.panel.setAttribute("aria-hidden", next ? "false" : "true");
    opts.stage.setAttribute("aria-hidden", next ? "true" : "false");
    opts.stage.inert = next;
    opts.panel.inert = !next;
    if (next) {
      const current = opts.list.querySelector<HTMLElement>(
        ".history-item.is-active .history-item-main",
      );
      (current ??
        opts.list.querySelector<HTMLElement>(".history-item-main"))?.focus();
    } else {
      opts.toggle.focus();
    }
  }

  function close(): void {
    setOpen(false);
  }

  function renderTitle(session: SessionSummary | null): void {
    if (!session) {
      opts.titleBtn.textContent = "New chat";
      opts.titleBtn.disabled = true;
      opts.titleBtn.removeAttribute("title");
      return;
    }
    const label = displaySessionTitle(session);
    opts.titleBtn.textContent = label;
    const url = (session.url || "").trim();
    if (isOpenableUrl(url)) {
      opts.titleBtn.disabled = false;
      opts.titleBtn.title = `Open ${session.host || url}`;
    } else {
      opts.titleBtn.disabled = true;
      opts.titleBtn.removeAttribute("title");
    }
  }

  function render(
    sessions: SessionSummary[],
    activeId: string | null,
  ): void {
    const visible = visibleSessions(sessions, activeId);
    opts.count.textContent = String(visible.length);
    opts.list.replaceChildren();

    active = visible.find((s) => s.id === activeId) ?? visible[0] ?? null;
    renderTitle(active);

    for (const s of visible) {
      const row = document.createElement("div");
      row.className = "history-item";
      if (s.id === activeId) row.classList.add("is-active");
      row.setAttribute("role", "listitem");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item-main";
      btn.title = displaySessionTitle(s);

      const title = document.createElement("span");
      title.className = "history-item-title";
      title.textContent = displaySessionTitle(s);

      const meta = document.createElement("span");
      meta.className = "history-item-meta";
      const host = (s.host || "").trim() || "page";
      meta.textContent = `${host} · ${relativeTime(s.updatedAt)}`;

      btn.append(title, meta);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        close();
        opts.onSelect(s.id);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "history-item-delete";
      del.title = "Delete chat";
      del.setAttribute("aria-label", `Delete ${displaySessionTitle(s)}`);
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onDelete(s.id);
      });

      row.append(btn, del);
      opts.list.append(row);
    }

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No chats yet";
      opts.list.append(empty);
    }

    if (open && !opts.list.contains(document.activeElement)) {
      const current = opts.list.querySelector<HTMLElement>(
        ".history-item.is-active .history-item-main",
      );
      (current ??
        opts.list.querySelector<HTMLElement>(".history-item-main"))?.focus();
    }
  }

  opts.toggle.addEventListener("click", (e) => {
    e.preventDefault();
    setOpen(!open);
  });

  opts.titleBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const url = (active?.url || "").trim();
    if (!isOpenableUrl(url)) return;
    opts.onOpenPage(url);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  });

  opts.panel.inert = true;
  opts.panel.setAttribute("aria-hidden", "true");

  return {
    render,
    close,
    isOpen: () => open,
  };
}
