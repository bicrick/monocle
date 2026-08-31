/**
 * Parse Cursor CLI `--output-format stream-json` NDJSON into human steps
 * (thinking, tool calls) plus the final assistant/result text for patches.
 */
export function createStreamParser({
  onStep,
  onThinking,
  onPayload,
} = {}) {
  let buffer = "";
  let thinkingBuf = "";
  let assistantParts = [];
  let resultText = "";
  let sawResult = false;
  let writingPatch = false;
  let patchStepEmitted = false;
  /** Cursor CLI chat id from stream-json events (for --resume). */
  let cursorSessionId = null;

  function emitStep(line) {
    const text = String(line || "").trim();
    if (!text) return;
    onStep?.(text);
  }

  function emitThinking(delta) {
    thinkingBuf += delta;
    onThinking?.(thinkingBuf);
  }

  function isPatchText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (t.startsWith("{") || t.startsWith("```")) return true;
    if (/"overlayHtml"\s*:/.test(t) || /"css"\s*:/.test(t) || /"runtime"\s*:/.test(t)) {
      return true;
    }
    if (/html\[data-monacle/.test(t) && /\{/.test(t)) return true;
    return false;
  }

  function currentPayload() {
    if (!assistantParts.length) return "";
    let acc = "";
    for (const part of assistantParts) {
      if (!part) continue;
      if (!acc) {
        acc = part;
        continue;
      }
      if (part.startsWith(acc) || part.includes(acc)) {
        if (part.length > acc.length) acc = part;
        continue;
      }
      if (acc.includes(part) || acc.endsWith(part)) continue;
      acc += part;
    }
    return acc;
  }

  function toolLabel(toolCall) {
    if (!toolCall || typeof toolCall !== "object") return "Tool";
    const key = Object.keys(toolCall)[0];
    if (!key) return "Tool";
    const body = toolCall[key] || {};
    const args = body.args || body;
    const name = key
      .replace(/ToolCall$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    const pretty =
      name.charAt(0).toUpperCase() + name.slice(1).replace(/Call$/, "");

    if (typeof args.path === "string") return `${pretty} ${args.path}`;
    if (typeof args.filePath === "string") return `${pretty} ${args.filePath}`;
    if (typeof args.pattern === "string") {
      return `${pretty} ${args.pattern.slice(0, 60)}`;
    }
    if (typeof args.command === "string") {
      return `${pretty} ${args.command.slice(0, 80)}`;
    }
    if (typeof args.query === "string") {
      return `${pretty} ${args.query.slice(0, 60)}`;
    }
    return pretty;
  }

  function handleEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    if (typeof evt.session_id === "string" && evt.session_id.trim()) {
      cursorSessionId = evt.session_id.trim();
    }
    const type = evt.type;

    if (type === "system" && evt.subtype === "init") {
      const model = evt.model || "auto";
      emitStep(`Model ${model}`);
      return;
    }

    if (type === "thinking") {
      if (evt.subtype === "delta" && typeof evt.text === "string") {
        emitThinking(evt.text);
      } else if (evt.subtype === "completed") {
        const summary = thinkingBuf.replace(/\s+/g, " ").trim();
        if (summary) {
          emitStep(
            summary.length > 160
              ? `Thinking: ${summary.slice(0, 157)}…`
              : `Thinking: ${summary}`,
          );
        } else {
          emitStep("Thinking…");
        }
        thinkingBuf = "";
      }
      return;
    }

    if (type === "tool_call") {
      if (evt.subtype === "started") {
        emitStep(`→ ${toolLabel(evt.tool_call)}`);
      } else if (evt.subtype === "completed") {
        const label = toolLabel(evt.tool_call);
        emitStep(`✓ ${label}`);
      }
      return;
    }

    if (type === "assistant" && evt.message?.content) {
      const chunks = Array.isArray(evt.message.content)
        ? evt.message.content
        : [];
      let text = "";
      for (const part of chunks) {
        if (part?.type === "text" && typeof part.text === "string") {
          text += part.text;
        } else if (typeof part === "string") {
          text += part;
        }
      }
      if (text) {
        assistantParts.push(text);
        const trimmed = text.trim();
        if (writingPatch || isPatchText(trimmed)) {
          writingPatch = true;
          if (!patchStepEmitted) {
            patchStepEmitted = true;
            emitStep("Writing restyle patch…");
          }
          onPayload?.(currentPayload());
        } else if (trimmed.length < 200) {
          emitStep(trimmed);
        } else {
          emitStep(`${trimmed.slice(0, 140)}…`);
        }
      }
      return;
    }

    if (type === "result") {
      sawResult = true;
      if (typeof evt.result === "string") resultText = evt.result;
      if (resultText && (writingPatch || isPatchText(resultText))) {
        onPayload?.(resultText);
      }
      if (evt.subtype === "success") {
        emitStep(
          evt.duration_ms
            ? `Done (${Math.round(evt.duration_ms / 1000)}s)`
            : "Done",
        );
      } else if (evt.is_error) {
        emitStep(`Error: ${evt.result || evt.error || "failed"}`);
      }
      return;
    }

    if (type === "error") {
      emitStep(`Error: ${evt.message || evt.error || JSON.stringify(evt)}`);
    }
  }

  function push(chunk) {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Non-JSON noise (rare) — surface briefly
      if (!trimmed.startsWith("{")) {
        emitStep(trimmed.slice(0, 160));
        continue;
      }
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        // incomplete / malformed line — ignore
      }
    }
  }

  function flush() {
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer.trim()));
      } catch {
        // ignore trailing junk
      }
      buffer = "";
    }
    if (thinkingBuf.trim()) {
      const summary = thinkingBuf.replace(/\s+/g, " ").trim();
      emitStep(
        summary.length > 160
          ? `Thinking: ${summary.slice(0, 157)}…`
          : `Thinking: ${summary}`,
      );
      thinkingBuf = "";
    }
  }

  function finalText() {
    if (sawResult && resultText) return resultText.trim();
    if (!assistantParts.length) return "";
    // Prefer the last JSON / patch-looking chunk (final answer after tools),
    // not an earlier short intent line like "I'll read the rest…".
    for (let i = assistantParts.length - 1; i >= 0; i--) {
      const part = (assistantParts[i] || "").trim();
      if (!part) continue;
      if (isPatchText(part) || /"message"\s*:/.test(part)) return part;
    }
    let best = assistantParts[assistantParts.length - 1] || "";
    for (const part of assistantParts) {
      if (part.length > best.length) best = part;
    }
    return best.trim();
  }

  return { push, flush, finalText, cursorSessionId: () => cursorSessionId };
}
