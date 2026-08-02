import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOutcomeFacts } from "@claudexor/schema";
import {
  ACP_MAX_REPLAY_TURNS,
  acpTerminalRecordMode,
  acpTerminalSummary,
  projectAcpRunControls,
  projectTerminalTurnDetail,
  selectReplayTurns,
  typedFetchReason,
} from "./acp-surface-runner.js";

describe("ACP run-control projection", () => {
  it("maps the Agent race alias to the strict n vocabulary", () => {
    expect(
      projectAcpRunControls({
        mode: "__acp_session_prompt",
        runMode: "agent",
        race: true,
        harness: "codex",
      }),
    ).toEqual({ mode: "agent", n: 2, harnesses: ["codex"] });
    expect(projectAcpRunControls({ runMode: "agent", race: true, n: 3 })).toEqual({
      mode: "agent",
      n: 3,
    });
    expect(projectAcpRunControls({ runMode: "agent", race: false })).toEqual({ mode: "agent" });
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;

const typedFailure = {
  phase: "execute",
  category: "auth",
  code: null,
  harnessId: "claude",
  attemptId: "a01",
  safeMessage: "Authentication expired",
  rawDetailRef: "attempts/a01/failure.json",
  resetsAt: null,
  logRefs: ["attempts/a01/stderr.log"],
  eventRefs: ["events.jsonl#42"],
  runDir: "/tmp/run-1",
  nextActions: ["Log in again"],
};

// The post-terminal detail read DEGRADES: a finished ACP turn must never become
// a JSON-RPC error that loses the runId — the terminal answer survives and the
// typed problem rides the result as detailProblem.
describe("projectTerminalTurnDetail (post-terminal degrade)", () => {
  it("carries a typed detailProblem instead of raising when the detail read fails", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockRejectedValue(
      Object.assign(new Error("canonical RunFacts receipt is invalid"), {
        code: "run_facts_invalid",
        retryable: false,
      }),
    );
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
        detailProblem: {
          code: "run_facts_invalid",
          message: "canonical RunFacts receipt is invalid",
          retryable: false,
        },
      });
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("projects eligibility, readiness, questions, and typed failure from ONE detail read", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      applyEligibility: {
        eligible: false,
        state: "needs_review",
        reason: null,
        requiredAction: null,
      },
      planReadiness: { state: "needs_answers", questionCount: 1 },
      planQuestions: [{ id: "q1" }],
      failure: typedFailure,
      summary: {
        outcomeFacts: makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
      },
      outcomeBanner: "Time limit reached",
      primaryOutput: {
        kind: "plan",
        path: "final/plan.md",
        text: "# Plan",
        bytes: 6,
        truncated: false,
      },
    });
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: {
          eligible: false,
          state: "needs_review",
          reason: null,
          requiredAction: null,
        },
        planReadiness: { state: "needs_answers", questionCount: 1 },
        planQuestions: [{ id: "q1" }],
        failure: typedFailure,
        outcomeFacts: makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
        outcomeBanner: "Time limit reached",
        primaryOutput: {
          kind: "plan",
          path: "final/plan.md",
          text: "# Plan",
          bytes: 6,
          truncated: false,
        },
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("does not forward a malformed failure-shaped object", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      failure: { category: "invented", safeMessage: 42 },
    });
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
      });
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("projects null fields for a missing/legacy detail and skips the read without a runId", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue(null);
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
      });
      await expect(projectTerminalTurnDetail(addr, "")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });
});

describe("ACP terminal primary-output projection", () => {
  const unavailableDetail = {
    applyEligibility: null,
    planReadiness: null,
    planQuestions: [],
    failure: null,
    primaryOutput: null,
    outcomeFacts: null,
    outcomeBanner: null,
    detailProblem: { code: "detail_unavailable", message: "offline", retryable: true },
  };

  it.each([
    ["wall_clock_exceeded", "Time limit reached"],
    ["user_cancelled", "Cancelled"],
  ] as const)("uses the server outcome banner for a cancelled %s terminal", (reason, banner) => {
    expect(
      acpTerminalSummary({
        runId: `run-${reason}`,
        runDir: "",
        record: { state: "cancelled", params: { mode: "agent" } },
        detail: {
          ...unavailableDetail,
          detailProblem: undefined,
          outcomeFacts: makeOutcomeFacts("cancelled", { reason }),
          outcomeBanner: banner,
        },
      }),
    ).toBe(banner);
  });

  it("uses the canonical Control API primary output when detail succeeds", () => {
    expect(
      acpTerminalSummary({
        runId: "run-plan",
        runDir: "",
        record: { state: "succeeded", params: { mode: "agent" } },
        detail: {
          ...unavailableDetail,
          detailProblem: undefined,
          primaryOutput: {
            kind: "plan",
            path: "final/plan.md",
            text: "Canonical plan\n",
            bytes: 15,
            truncated: false,
          },
        },
      }),
    ).toBe("Canonical plan");
  });

  it.each([
    { mode: "plan" as const, file: "plan.md", text: "Fallback plan" },
    { mode: "ask" as const, file: "report.md", text: "Fallback research report" },
  ])("uses the durable $mode mode only when detail is unavailable", ({ mode, file, text }) => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-acp-output-"));
    tempDirs.push(root);
    mkdirSync(join(root, "final"), { recursive: true });
    writeFileSync(join(root, "final", file), `${text}\n`);
    expect(
      acpTerminalSummary({
        runId: `run-${mode}`,
        runDir: root,
        record: { state: "succeeded", params: { mode } },
        detail: unavailableDetail,
      }),
    ).toBe(text);
  });

  it("recovers a cancelled Ask diagnostic without guessing Agent", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-acp-cancelled-"));
    tempDirs.push(root);
    mkdirSync(join(root, "final"), { recursive: true });
    writeFileSync(join(root, "final", "summary.md"), "Stopped after deadline\n");
    expect(
      acpTerminalSummary({
        runId: "run-ask-cancelled",
        runDir: root,
        record: { state: "cancelled", params: { mode: "ask" } },
        detail: unavailableDetail,
      }),
    ).toBe("Stopped after deadline");
  });

  it("accepts only the canonical mode vocabulary from daemon params", () => {
    expect(acpTerminalRecordMode({ params: { mode: "ask" } })).toBe("ask");
    expect(acpTerminalRecordMode({ params: { mode: "plan" } })).toBe("plan");
    expect(acpTerminalRecordMode({ params: { mode: "legacy-audit" } })).toBeUndefined();
    expect(acpTerminalRecordMode({ params: null })).toBeUndefined();
  });
});

// W5: the ACP session/load replay is bounded, and a failed per-turn detail
// fetch discloses a typed reason instead of vanishing.
describe("ACP load-replay bounding (W5)", () => {
  it("keeps every turn when the thread is within the cap", () => {
    const turns = Array.from({ length: 10 }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns).toEqual(turns);
    expect(omittedTurnCount).toBe(0);
  });

  it("keeps only the most recent N turns and reports the omitted count", () => {
    const total = ACP_MAX_REPLAY_TURNS + 12;
    const turns = Array.from({ length: total }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns.length).toBe(ACP_MAX_REPLAY_TURNS);
    // The tail (most recent) is kept, in chronological order.
    expect(replayTurns[0]).toBe(12);
    expect(replayTurns.at(-1)).toBe(total - 1);
    expect(omittedTurnCount).toBe(12);
  });
});

describe("typedFetchReason (W5)", () => {
  it("prefers the typed control-API code", () => {
    expect(
      typedFetchReason(
        Object.assign(new Error("gone"), { code: "run_expired_by_retention", status: 410 }),
      ),
    ).toBe("run_expired_by_retention");
  });

  it("falls back to the HTTP status, then a generic marker", () => {
    expect(typedFetchReason(Object.assign(new Error("boom"), { status: 503 }))).toBe("http_503");
    expect(typedFetchReason(new Error("transport blew up"))).toBe("detail_unavailable");
    expect(typedFetchReason(undefined)).toBe("detail_unavailable");
  });
});
