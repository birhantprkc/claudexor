import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type Json = any;

/**
 * Map an Antigravity CLI (`agy -p --output-format stream-json`) ND-JSON event
 * to normalized events. Field shapes are pinned by RECORDED fixtures captured
 * on agy 1.1.13 (fixtures/manifest.yaml): `init` / `step_update` / `result`,
 * with `step_update.step_type` an OPEN vocabulary
 * (user_input | agent_response | tool | checkpoint | finish | unknown | …).
 * Unknown step types are recognized no-ops (empty array, never a drop);
 * unknown TOP-LEVEL events return `null` so the run loop counts them.
 */
export function parseAgyEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  const ts = nowIso();
  const event = String(obj?.event ?? "");

  if (event === "init") {
    const nativeId = stringOrUndef(obj.conversation_id);
    const model = stringOrUndef(obj.init?.model);
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        ...(model ? { observed_model: model } : {}),
        // The vendor conversation id IS the resumable native session
        // (`agy --conversation <id>`); surface it for INV-137 lane resume.
        ...(nativeId ? { payload: { native_session_id: nativeId } } : {}),
      },
    ];
  }

  if (event === "step_update") {
    const step = obj.step_update ?? {};
    const stepType = String(step.step_type ?? "");
    const events: HarnessEvent[] = [];

    if (stepType === "tool") {
      const info = step.tool_info ?? {};
      const name = String(info.name ?? step.tool_name ?? "tool");
      const target = boundedTarget(primaryToolTarget(info.parameters));
      const tool: ToolRef = { name, kind: toolKindFor(name), target };
      const active = String(step.state ?? "") === "ACTIVE";
      if (active) {
        // ACTIVE/DONE arrive as a pair per call (fixture-pinned): ACTIVE is
        // the call, DONE the result.
        events.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool });
      } else {
        const errorDetail = summarize(info.error);
        if (errorDetail) {
          events.push({
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: `tool_result: error: ${errorDetail}`,
            tool: { ...tool, status: "error", error_summary: errorDetail },
          });
        } else {
          const output = summarize(info.output);
          events.push({
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: "tool_result",
            tool: { ...tool, status: "ok", content_summary: output || undefined },
          });
          if (WRITE_TOOLS.test(name)) {
            events.push({
              type: "file_change",
              session_id: sessionId,
              ts,
              tool: { name, kind: "file" },
              payload: { path: primaryToolTarget(info.parameters), tool: name },
            });
          }
        }
      }
    } else if (typeof step.text_delta === "string" && step.text_delta) {
      // agent_response chunks: completed narration segments (not display
      // deltas — no payload.delta). The typed final comes from `result`.
      events.push({ type: "message", session_id: sessionId, ts, text: step.text_delta });
    }
    // user_input / checkpoint / finish / unknown / future types: recognized
    // lifecycle no-ops beyond their usage payload below.

    const usage = stepUsage(step.usage);
    if (usage) events.push({ type: "usage", session_id: sessionId, ts, usage });
    return events;
  }

  if (event === "result") {
    const r = obj.result ?? {};
    const status = String(r.status ?? "");
    const events: HarnessEvent[] = [];
    const usage = stepUsage(r.usage);

    if (status === "SUCCESS") {
      // Л-20: with a schema envelope the parsed object rides
      // `structured_output` while `response` concatenates prose AND the JSON;
      // serialize the parsed object as the typed final (codex model) instead
      // of parsing mixed text. Without a schema the final is `response`.
      const structured = r.structured_output;
      const finalText =
        structured !== undefined && structured !== null
          ? JSON.stringify(structured)
          : typeof r.response === "string"
            ? r.response
            : "";
      if (finalText.trim()) {
        events.push({
          type: "message",
          session_id: sessionId,
          ts,
          text: finalText,
          final: true,
          payload: {
            final_source: structured !== undefined && structured !== null ? "structured_output" : "result",
          },
        });
      } else {
        // Vendor soft-deny class (upstream #794): SUCCESS with an empty
        // response means a permission-denied turn that did nothing. Honest
        // typed error, never a silent empty success.
        events.push({
          type: "error",
          session_id: sessionId,
          ts,
          error:
            "agy reported SUCCESS with an empty response (vendor soft-deny: a required tool permission was auto-denied)",
        });
      }
    } else {
      events.push({
        type: "error",
        session_id: sessionId,
        ts,
        error: summarize(r.error) || `agy terminal status ${status || "unknown"}`,
      });
    }
    if (usage) events.push({ type: "usage", session_id: sessionId, ts, usage });
    return events;
  }

  return null;
}

const WRITE_TOOLS = /write|edit|replace|apply|patch/i;

function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("command") || n.includes("shell") || n.includes("bash")) return "command";
  if (n.includes("search") || n.includes("grep") || n.includes("glob") || n.includes("list_dir"))
    return "search";
  if (n.includes("browser") || n.includes("url") || n.includes("web")) return "web";
  if (WRITE_TOOLS.test(n) || n.includes("read") || n.includes("file") || n.includes("view"))
    return "file";
  if (n.includes("mcp")) return "mcp";
  return "other";
}

/** The one human-meaningful target among agy's PascalCase tool parameters. */
function primaryToolTarget(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  for (const key of ["TargetFile", "AbsolutePath", "DirectoryPath", "CommandLine", "Query", "Url"]) {
    const v = p[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * agy usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 * total_tokens}. `thinking_tokens` has no schema home and is deliberately
 * DROPPED (disclosed absence), never folded into output (PLAN R-9).
 */
function stepUsage(raw: unknown): HarnessEvent["usage"] | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const usage: NonNullable<HarnessEvent["usage"]> = {};
  if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
  if (typeof u.cache_read_tokens === "number") usage.cached_input_tokens = u.cache_read_tokens;
  return Object.keys(usage).length ? usage : null;
}

function summarize(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return redactSecrets(value).trim().replace(/\s+/g, " ").slice(0, 1000);
}

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSecrets(value).slice(0, 500);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
