/** Message contract between the content-script host and the eval sandbox. */

export const HOST_SOURCE = "monacle-host";
export const SANDBOX_SOURCE = "monacle-sandbox";

export const FRAME_ID = "monacle-runtime-frame";

export interface SandboxHostHandlers {
  query: (selector: string) => unknown[];
  insert: (
    html: string,
    opts: { selector: string; position?: string },
  ) => unknown[];
  css: (text: string) => void;
  /** Apply inline styles on a previously queried live node. */
  style: (
    selector: string,
    index: number,
    props: Record<string, string>,
  ) => void;
  media: () => unknown[];
  viewport: () => { width: number; height: number };
  canvas: () => HTMLCanvasElement;
}

export interface SerializedNode {
  tag: string;
  id: string;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
}

export type HostCallResult =
  | { kind: "query"; selector: string; nodes: unknown[] }
  | { kind: "insert" }
  | { kind: "css" }
  | { kind: "style" }
  | { kind: "ignored" };

export function dispatchHostCall(
  method: string,
  args: unknown[],
  handlers: Pick<SandboxHostHandlers, "query" | "insert" | "css" | "style">,
): HostCallResult {
  if (method === "query" && typeof args[0] === "string") {
    return { kind: "query", selector: args[0], nodes: handlers.query(args[0]) };
  }
  if (method === "insert") {
    handlers.insert(String(args[0] ?? ""), (args[1] as { selector: string }) ?? {
      selector: "body",
    });
    return { kind: "insert" };
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
  return { kind: "ignored" };
}
