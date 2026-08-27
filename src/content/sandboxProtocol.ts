/** Message contract between the content-script host and the eval sandbox. */

export const HOST_SOURCE = "monacle-host";
export const SANDBOX_SOURCE = "monacle-sandbox";

export const FRAME_ID = "monacle-runtime-frame";

export interface ThreeHostApi {
  clear: () => void;
  setBackground: (value: unknown) => void;
  add: (spec: Record<string, unknown>) => void;
  update: (id: string, props: Record<string, unknown>) => void;
  remove: (id: string) => void;
  camera: (spec: Record<string, unknown>) => void;
  lights: (list: unknown[]) => void;
  ensure: () => void;
}

export interface SandboxHostHandlers {
  query: (selector: string) => unknown[];
  /** Page-level insert (selector required; defaults to body). */
  insert: (
    html: string,
    opts: { selector: string; position?: string; batchId?: string },
  ) => unknown[];
  /**
   * Create Monacle-owned nodes. Default parent is #monacle-scene in the overlay.
   * Optional selector uses the page insert path.
   */
  create: (
    html: string,
    opts?: { selector?: string; position?: string; batchId?: string },
  ) => unknown[];
  css: (text: string) => void;
  /** Apply inline styles on a previously queried live node. */
  style: (
    selector: string,
    index: number,
    props: Record<string, string>,
  ) => void;
  three: ThreeHostApi;
  media: () => unknown[];
  viewport: () => { width: number; height: number };
}

export interface SerializedNode {
  tag: string;
  id: string;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
}

export type HostCallResult =
  | { kind: "query"; selector: string; nodes: unknown[] }
  | { kind: "create"; selector: string; nodes: unknown[] }
  | { kind: "insert"; selector: string; nodes: unknown[] }
  | { kind: "css" }
  | { kind: "style" }
  | { kind: "three" }
  | { kind: "ignored" };

function batchSelector(batchId: string | undefined): string {
  if (batchId && typeof batchId === "string" && batchId.trim()) {
    return `[data-monacle-batch="${batchId.trim()}"]`;
  }
  return "[data-monacle-insert]";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function dispatchHostCall(
  method: string,
  args: unknown[],
  handlers: Pick<
    SandboxHostHandlers,
    "query" | "insert" | "create" | "css" | "style" | "three"
  >,
): HostCallResult {
  if (method === "query" && typeof args[0] === "string") {
    return { kind: "query", selector: args[0], nodes: handlers.query(args[0]) };
  }
  if (method === "create") {
    const opts =
      args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
        ? (args[1] as {
            selector?: string;
            position?: string;
            batchId?: string;
          })
        : {};
    const nodes = handlers.create(String(args[0] ?? ""), opts);
    return {
      kind: "create",
      selector: batchSelector(opts.batchId),
      nodes,
    };
  }
  if (method === "insert") {
    const opts =
      (args[1] as {
        selector?: string;
        position?: string;
        batchId?: string;
      }) ?? {};
    const selector =
      typeof opts.selector === "string" && opts.selector.trim()
        ? opts.selector
        : "body";
    const nodes = handlers.insert(String(args[0] ?? ""), {
      selector,
      position: opts.position,
      batchId: opts.batchId,
    });
    return {
      kind: "insert",
      selector: batchSelector(opts.batchId),
      nodes,
    };
  }
  if (method === "css") {
    handlers.css(String(args[0] ?? ""));
    return { kind: "css" };
  }
  if (method === "style" && typeof args[0] === "string") {
    const index = typeof args[1] === "number" ? args[1] : Number(args[1]) || 0;
    const props =
      args[2] && typeof args[2] === "object" && !Array.isArray(args[2])
        ? (args[2] as Record<string, string>)
        : {};
    handlers.style(args[0], index, props);
    return { kind: "style" };
  }
  if (method === "three" && typeof args[0] === "string") {
    const cmd = args[0];
    const three = handlers.three;
    if (cmd === "clear") three.clear();
    else if (cmd === "ensure") three.ensure();
    else if (cmd === "setBackground") three.setBackground(args[1]);
    else if (cmd === "add") three.add(asRecord(args[1]));
    else if (cmd === "update") {
      three.update(String(args[1] ?? ""), asRecord(args[2]));
    } else if (cmd === "remove") three.remove(String(args[1] ?? ""));
    else if (cmd === "camera") three.camera(asRecord(args[1]));
    else if (cmd === "lights") {
      three.lights(Array.isArray(args[1]) ? args[1] : []);
    }
    return { kind: "three" };
  }
  return { kind: "ignored" };
}
