/**
 * Parse Cursor CLI `--output-format stream-json` NDJSON into human steps
 * (thinking, tool calls) plus the final assistant/result text for patches.
 */
export function createStreamParser({
  onStep,
  onThinking,
} = {}) {
  let buffer = "";
  let thinkingBuf = "";
  let assistantParts = [];
  let resultText = "";
  let sawResult = false;

  function emitStep(line) {
    const text = String(line || "").trim();
    if (!text) return;
    onStep?.(text);
  }

  function emitThinking(delta) {
    thinkingBuf += delta;
    onThinking?.(thinkingBuf);
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
        // Don't dump huge JSON patches into the step UI — just note progress.
        const trimmed = text.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
          emitStep("Writing restyle patch…");
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
    // Deduplicate overlapping assistant chunks if CLI replayed full messages
    if (!assistantParts.length) return "";
    const last = assistantParts[assistantParts.length - 1] || "";
    // Prefer the longest chunk (often the full message after deltas)
    let best = last;
    for (const part of assistantParts) {
      if (part.length > best.length) best = part;
    }
    return best.trim();
  }

  return { push, flush, finalText };
}
