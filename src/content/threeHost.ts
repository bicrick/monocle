/**
 * Inject and drive the page-world Three.js stage from the content script.
 * Commands are posted into the page; WebGL never runs in the extension process.
 *
 * Successive restyles: inject once per tab, stop/restart the renderer via
 * commands — never re-execute the stage IIFE (duplicate listeners race).
 */

import { reportRuntimeError } from "./runtimeErrors";

const HOST_SOURCE = "monacle-three-host";
const STAGE_SOURCE = "monacle-three-stage";

let listening = false;
/** Script has been injected into the page MAIN world (survives stop). */
let stageInjected = false;
/** Renderer is live and accepting commands. */
let ready = false;
let injecting: Promise<void> | null = null;
let cmdSeq = 0;
const queue: Array<{ cmd: string; args: unknown[]; id?: number }> = [];
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
>();

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", onPageMessage);
}

function flushQueue(): void {
  if (!ready) return;
  while (queue.length) {
    const item = queue.shift()!;
    window.postMessage(
      {
        source: HOST_SOURCE,
        type: "monacle-three-cmd",
        id: item.id,
        cmd: item.cmd,
        args: item.args,
      },
      "*",
    );
  }
}

function rejectPending(reason: string): void {
  for (const [id, waiter] of pending) {
    window.clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
    pending.delete(id);
  }
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== STAGE_SOURCE) return;

  if (data.type === "booted" || data.type === "ready") {
    stageInjected = true;
    // Accidental re-inject on an already-installed stage: ask it to ensure
    // the renderer instead of treating booted as ready (may be post-stop).
    if (data.type === "booted" && data.reused) {
      window.postMessage(
        {
          source: HOST_SOURCE,
          type: "monacle-three-cmd",
          cmd: "ensure",
          args: [],
        },
        "*",
      );
      return;
    }
    ready = true;
    flushQueue();
    return;
  }

  if (data.type === "result" && typeof data.id === "number") {
    const waiter = pending.get(data.id);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      pending.delete(data.id);
    }
    waiter?.resolve(data.result);
    return;
  }

  // Host owns ready on stopThreeStage / ensure. Ignoring late "stopped" avoids
  // a race where tearDown's stopped arrives after the next ensure's ready.
  if (data.type === "stopped") {
    return;
  }

  if (data.type === "error") {
    const message =
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Three.js stage error";
    if (data.fatal) {
      ready = false;
      queue.length = 0;
      rejectPending(message);
    }
    reportRuntimeError(message, Boolean(data.fatal));
    if (typeof data.id === "number") {
      const waiter = pending.get(data.id);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        pending.delete(data.id);
        waiter.reject(new Error(message));
      }
    }
  }
}

function waitUntilReady(timeoutMs = 3000): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = window.setInterval(() => {
      if (ready || Date.now() - start > timeoutMs) {
        window.clearInterval(poll);
        resolve();
      }
    }, 50);
  });
}

/** Inject the bundled stage script into the page MAIN world via the service worker. */
export function ensureThreeStage(): Promise<void> {
  ensureListener();
  if (ready) return Promise.resolve();

  // Already injected: ask the stage to recreate the renderer (no re-inject).
  if (stageInjected) {
    window.postMessage(
      {
        source: HOST_SOURCE,
        type: "monacle-three-cmd",
        cmd: "ensure",
        args: [],
      },
      "*",
    );
    return waitUntilReady();
  }

  if (injecting) return injecting;
  injecting = chrome.runtime
    .sendMessage({ type: "INJECT_THREE_STAGE" })
    .then((res) => {
      if (res && res.ok === false) {
        throw new Error(res.error || "Failed to inject Three.js stage");
      }
      stageInjected = true;
      return waitUntilReady();
    })
    .finally(() => {
      injecting = null;
    });
  return injecting;
}

function enqueue(cmd: string, args: unknown[] = [], id?: number): void {
  ensureListener();
  void ensureThreeStage();
  if (ready) {
    window.postMessage(
      { source: HOST_SOURCE, type: "monacle-three-cmd", id, cmd, args },
      "*",
    );
  } else {
    queue.push({ cmd, args, id });
  }
}

function postCmd(cmd: string, args: unknown[] = []): Promise<unknown> {
  const id = ++cmdSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Three.js command timed out: ${cmd}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    enqueue(cmd, args, id);
  });
}

function postCmdFire(cmd: string, args: unknown[] = []): void {
  enqueue(cmd, args, ++cmdSeq);
}

export function threeEnsure(): Promise<unknown> {
  return postCmd("ensure");
}

export function threeClear(): void {
  postCmdFire("clear");
}

export function threeSetBackground(value: unknown): void {
  postCmdFire("setBackground", [value]);
}

export function threeAdd(spec: Record<string, unknown>): void {
  postCmdFire("add", [spec]);
}

export function threeUpdate(
  id: string,
  props: Record<string, unknown>,
): void {
  postCmdFire("update", [id, props]);
}

export function threeRemove(id: string): void {
  postCmdFire("remove", [id]);
}

export function threeCamera(spec: Record<string, unknown>): void {
  postCmdFire("camera", [spec]);
}

export function threeLights(list: unknown[]): void {
  postCmdFire("lights", [list]);
}

export function stopThreeStage(): void {
  queue.length = 0;
  // Always post stop when the page script exists — even if ready was false
  // (mid-inject / late race) — so page-world raf cannot keep running.
  if (stageInjected) {
    window.postMessage(
      {
        source: HOST_SOURCE,
        type: "monacle-three-cmd",
        cmd: "stop",
        args: [],
      },
      "*",
    );
  }
  document.getElementById("monacle-three-root")?.remove();
  ready = false;
  rejectPending("Three.js stage stopped");
}

/** Full leave / reset — allow a fresh inject on the next ensure. */
export function destroyThreeStage(): void {
  stopThreeStage();
  stageInjected = false;
}

export interface ThreeApi {
  clear(): void;
  setBackground(value: unknown): void;
  add(spec: Record<string, unknown>): void;
  update(id: string, props: Record<string, unknown>): void;
  remove(id: string): void;
  camera(spec: Record<string, unknown>): void;
  lights(list: unknown[]): void;
  ensure(): void;
}

export function buildThreeApi(): ThreeApi {
  return {
    clear: () => threeClear(),
    setBackground: (value) => threeSetBackground(value),
    add: (spec) => threeAdd(spec && typeof spec === "object" ? spec : {}),
    update: (id, props) =>
      threeUpdate(String(id), props && typeof props === "object" ? props : {}),
    remove: (id) => threeRemove(String(id)),
    camera: (spec) =>
      threeCamera(spec && typeof spec === "object" ? spec : {}),
    lights: (list) => threeLights(Array.isArray(list) ? list : []),
    ensure: () => {
      void threeEnsure();
    },
  };
}
