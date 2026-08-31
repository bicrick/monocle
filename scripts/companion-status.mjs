/**
 * Agent-step snapshots for the sidepanel and loops.
 * Backed by the multi-session registry — one run no longer clobbers another.
 */
export {
  SessionError,
  activeCount,
  aggregateSnapshot,
  beginRun,
  cancelPendingTool,
  endRun,
  ingestChunk,
  ingestPayload,
  ingestStep,
  ingestThinking,
  listSnapshots,
  maxConcurrent,
  requestTool,
  resolveTool,
  setSessionOrigin,
  snapshot,
} from "./companion-sessions.mjs";
