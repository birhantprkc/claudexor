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
  // A non-string `event` must not be COERCED: an object whose `toString` is
  // not callable throws, and the run loop would report a mid-stream parse
  // failure as "the harness failed to start" and drop the rest of the run.
  const event = typeof obj?.event === "string" ? obj.event : "";

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
    const stepType = typeof step.step_type === "string" ? step.step_type : "";
    const events: HarnessEvent[] = [];

    if (stepType === "tool") {
      const info = step.tool_info ?? {};
      const name =
        typeof info.name === "string" && info.name
          ? info.name
          : typeof step.tool_name === "string" && step.tool_name
            ? step.tool_name
            : "tool";
      const target = boundedTarget(primaryToolTarget(info.parameters));
      const tool: ToolRef = { name, kind: toolKindFor(name), target };
      const state = typeof step.state === "string" ? step.state : "";
      if (state === "ACTIVE") {
        // ACTIVE/DONE arrive as a pair per call (fixture-pinned): ACTIVE is
        // the call, DONE the result.
        events.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool });
      } else if (state === "DONE") {
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
          if (isWriteTool(name)) {
            events.push({
              type: "file_change",
              session_id: sessionId,
              ts,
              tool: { name, kind: "file" },
              payload: { path: boundedTarget(primaryToolTarget(info.parameters)), tool: name },
            });
          }
        }
      }
      // Any OTHER state (PENDING/CANCELLED/ERROR/absent, or a future value) is
      // a recognized lifecycle no-op: claiming success for it would fabricate
      // a completed tool call — and, for a write-named tool, a file change
      // that never happened (Ф0 review #1).
    } else if (typeof step.text_delta === "string" && step.text_delta) {
      // agent_response chunks: completed narration segments (not display
      // deltas — no payload.delta). The typed final comes from `result`.
      events.push({ type: "message", session_id: sessionId, ts, text: step.text_delta });
    }
    // user_input / checkpoint / finish / unknown / future types: recognized
    // lifecycle no-ops. Step usage is deliberately NOT emitted: the recorded
    // fixtures prove the per-step usages sum EXACTLY to the terminal
    // aggregate, so emitting both counted every token twice (sol review).
    // The one authoritative usage event rides `result`.
    return events;
  }

  if (event === "result") {
    const r = obj.result ?? {};
    const status = typeof r.status === "string" ? r.status : "";
    const events: HarnessEvent[] = [];
    const usage = stepUsage(r.usage);

    if (status === "SUCCESS") {
      // Л-20: with a schema envelope the parsed object rides
      // `structured_output` while `response` concatenates prose AND the JSON;
      // serialize the parsed object as the typed final (codex model) instead
      // of parsing mixed text. Without a schema the final is `response`.
      // Only an OBJECT envelope is a structured final: `false`/`0`/`""` are
      // not envelopes and must fall through to the prose response (review #7).
      const structured =
        r.structured_output !== null && typeof r.structured_output === "object"
          ? r.structured_output
          : null;
      const finalText =
        structured !== null
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
            final_source: structured !== null ? "structured_output" : "result",
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
            "agy reported SUCCESS with an empty response (no output produced; commonly a vendor soft-deny of a required tool permission)",
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

/** Tools that MUTATE the workspace. The regex catches the vendor's naming
 * convention; the allowlist covers proven writers whose names do not match
 * (`generate_image` writes an image file — Ф0 review #5). `sed_file` is
 * deliberately absent: whether it mutates on 1.1.13 is unverified, and
 * claiming a file change we cannot prove is the same defect class as #1. */
const WRITE_TOOL_NAMES = new Set(["generate_image"]);
const WRITE_TOOLS_RE = /write|edit|replace|apply|patch/i;
function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name) || WRITE_TOOLS_RE.test(name);
}

function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("command") || n.includes("shell") || n.includes("bash")) return "command";
  if (n.includes("search") || n.includes("grep") || n.includes("glob") || n.includes("list_dir"))
    return "search";
  if (n.includes("browser") || n.includes("url") || n.includes("web")) return "web";
  if (isWriteTool(n) || n.includes("read") || n.includes("file") || n.includes("view"))
    return "file";
  if (n.includes("mcp")) return "mcp";
  return "other";
}

/** The one human-meaningful target among agy's PascalCase tool parameters. */
function primaryToolTarget(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  for (const key of [
    "TargetFile",
    "AbsolutePath",
    "DirectoryPath",
    "CommandLine",
    "Query",
    "Url",
  ]) {
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
  if (typeof value === "string")
    return value.trim() ? redactSecrets(value).trim().replace(/\s+/g, " ").slice(0, 1000) : "";
  // A non-string detail (the vendor sometimes nests an object) must not be
  // silently dropped into a generic message (Ф0 review #7).
  if (value === null || value === undefined) return "";
  try {
    return redactSecrets(JSON.stringify(value)).trim().slice(0, 1000);
  } catch {
    return "";
  }
}

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSecrets(value).slice(0, 500);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
