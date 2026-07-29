import { makeOutcomeFacts } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonOutcomeSummary,
  enqueueAndAwait,
  exitCodeForState,
  mergeDaemonRunOutcome,
} from "./daemon-run.js";

afterEach(() => vi.unstubAllGlobals());

describe("exitCodeForState (D8: the lifecycle IS the exit code)", () => {
  it("maps a succeeded lifecycle to 0 and every other lifecycle to 1", () => {
    // A succeeded lifecycle is 0 — a "Done · needs review" run is still
    // succeeded and exits 0; applyability speaks through applyEligibility.
    expect(exitCodeForState("succeeded")).toBe(0);
    for (const bad of ["failed", "cancelled", "interrupted"]) {
      expect(exitCodeForState(bad)).toBe(1);
    }
  });
});

describe("daemonOutcomeSummary (P2: a reason on every non-clean daemon terminal, D8)", () => {
  it("returns undefined for a clean succeeded run (no summary key)", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "succeeded" })).toBeUndefined();
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "succeeded",
        outcomeFacts: makeOutcomeFacts("succeeded", { noChanges: true }),
      }),
    ).toBeUndefined();
  });

  it("surfaces the actionable decision hint for a needs-decision run (succeeded + review blocked)", () => {
    const s = daemonOutcomeSummary({
      runId: "run-abc",
      status: "succeeded",
      outcomeFacts: makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    });
    expect(s).toContain("decision");
    expect(s).toContain("claudexor decision run-abc");
  });

  it("prefers a real error message when present", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "failed", error: "boom" })).toBe("boom");
  });

  it("falls back to a lifecycle+reason label for other non-succeeded terminals", () => {
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "not_converged" }),
      }),
    ).toBe("run failed (not_converged)");
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "stuck_no_progress" }),
      }),
    ).toBe("run failed (stuck_no_progress)");
  });
});

describe("enqueueAndAwait typed ControlProblem transport", () => {
  it("never forwards a client-supplied frozen-plan reference to a thread turn", async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        posted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ jobId: "job-turn", runId: "run-turn", runDir: "/tmp/run-turn" }),
          { status: 202 },
        );
      }),
    );
    const client = { status: vi.fn().mockResolvedValue({ state: "running" }) };
    await enqueueAndAwait(
      client as never,
      { baseUrl: "http://127.0.0.1:1", token: "t" },
      {
        threadId: "thread-1",
        prompt: "implement",
        planRef: { runId: "forged", sha256: "a".repeat(64), path: "/tmp/forged" },
      },
      { waitForTerminal: false },
    );
    expect(posted).toEqual({ prompt: "implement" });
  });

  it("preserves Git remediation instead of flattening the failed start to prose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "git_developer_tools_stub",
              message: "Git is unavailable because Apple Command Line Tools are not installed.",
              retryable: false,
              fieldErrors: {},
              requiredActions: ["Install Apple Command Line Tools with `xcode-select --install`."],
              evidenceRefs: [],
              context: { capability: "git", capabilityStatus: "developer_tools_stub" },
            }),
            { status: 503, headers: { "content-type": "application/problem+json" } },
          ),
      ),
    );
    await expect(
      enqueueAndAwait(
        {} as never,
        { baseUrl: "http://127.0.0.1:1", token: "t" },
        { prompt: "go", mode: "agent" },
        { waitForTerminal: false },
      ),
    ).rejects.toMatchObject({
      code: "git_developer_tools_stub",
      retryable: false,
      requiredActions: [expect.stringContaining("xcode-select --install")],
      context: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });

  it("preserves the durable daemon status problem when a run is refused before materialization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jobId: "job-git-refused" }), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = {
      status: vi.fn().mockResolvedValue({
        id: "job-git-refused",
        state: "failed",
        error: "Git is unavailable because Apple Command Line Tools are not installed.",
        errorCode: "git_developer_tools_stub",
        errorStatus: 503,
        errorRetryable: false,
        errorRequiredActions: ["Install Apple Command Line Tools with `xcode-select --install`."],
        errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
      }),
    };

    await expect(
      enqueueAndAwait(
        client as never,
        { baseUrl: "http://127.0.0.1:1", token: "t" },
        { prompt: "go", mode: "agent" },
        { waitForTerminal: true },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "git_developer_tools_stub",
      errorRetryable: false,
      errorRequiredActions: [expect.stringContaining("xcode-select --install")],
      errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });

  it("preserves the typed terminal problem when an NDJSON/human run merges final status", () => {
    expect(
      mergeDaemonRunOutcome(
        {
          runId: "run-git-refused",
          runDir: "/runs/run-git-refused",
          status: "running",
          jobId: "job-git-refused",
        },
        {
          state: "failed",
          error: "Git is unavailable",
          errorCode: "git_developer_tools_stub",
          errorStatus: 503,
          errorRetryable: false,
          errorRequiredActions: ["Install Apple Command Line Tools with xcode-select --install."],
          errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
        },
      ),
    ).toMatchObject({
      status: "failed",
      errorCode: "git_developer_tools_stub",
      errorRetryable: false,
      errorRequiredActions: [expect.stringContaining("xcode-select --install")],
      errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });
});
