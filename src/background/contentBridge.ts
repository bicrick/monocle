import type { PageRead, Patch, RuntimeMessage } from "../shared/types";

export function isRestrictedUrl(url: string): boolean {
  return (
    !url ||
    /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url) ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export async function sendPageRead(tabId: number): Promise<PageRead> {
  await ensureContentScript(tabId);
  const res = (await chrome.tabs.sendMessage(tabId, {
    type: "GET_PAGE_READ",
  })) as RuntimeMessage;
  if (res?.type === "PAGE_READ" && res.page) return res.page;
  throw new Error("Page read failed");
}

/** Navigate the tab and wait until a content script can answer again. */
export async function navigateTab(
  tabId: number,
  targetUrl: string,
  originUrl: string,
): Promise<PageRead> {
  let resolved: string;
  try {
    resolved = new URL(targetUrl, originUrl).toString();
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }
  if (isRestrictedUrl(resolved)) {
    throw new Error("That URL cannot be opened by Monacle");
  }
  if (!sameOrigin(resolved, originUrl)) {
    throw new Error("Navigate is limited to the same site as this chat");
  }

  await chrome.tabs.update(tabId, { url: resolved });

  const start = Date.now();
  while (Date.now() - start < 20_000) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status && tab.status !== "complete") continue;
      if (isRestrictedUrl(tab.url || "")) {
        throw new Error("Landed on a restricted page");
      }
      return await sendPageRead(tabId);
    } catch (err) {
      if (
        err instanceof Error &&
        /restricted|same site|cannot be opened/i.test(err.message)
      ) {
        throw err;
      }
      // content script not ready yet
    }
  }
  throw new Error("Timed out waiting for page after navigate");
}

export interface ContentPing {
  hasPatch: boolean;
  runtimeLive: boolean;
}

export async function pingTab(tabId: number): Promise<ContentPing | null> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as
      | { ok?: boolean; hasPatch?: boolean; runtimeLive?: boolean }
      | undefined;
    if (!res?.ok) return null;
    return {
      hasPatch: Boolean(res.hasPatch),
      runtimeLive: Boolean(res.runtimeLive),
    };
  } catch {
    return null;
  }
}

export async function injectDeclaredContentScript(tabId: number): Promise<void> {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!files?.length) {
    throw new Error("Manifest is missing a content script");
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });
}

/** Inject only when the tab has no live content world (avoids stacked copies). */
export async function ensureContentScript(tabId: number): Promise<ContentPing | null> {
  const existing = await pingTab(tabId);
  if (existing) return existing;
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url || "")) {
    throw new Error(
      "This page cannot run Monacle (chrome://, Web Store, or similar). Open a normal website tab.",
    );
  }
  await injectDeclaredContentScript(tabId);
  const start = Date.now();
  while (Date.now() - start < 1500) {
    const live = await pingTab(tabId);
    if (live) return live;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pingTab(tabId);
}

export async function sendApplyPatch(
  tabId: number,
  patch: Patch,
): Promise<RuntimeMessage> {
  return (await chrome.tabs.sendMessage(tabId, {
    type: "APPLY_PATCH",
    patch,
  })) as RuntimeMessage;
}
