import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import type { CandidateRun } from "./candidateEvidence.js";
import { createAttemptTelemetry } from "./attemptTelemetry.js";
import { persistFailedInPlaceWorkProduct } from "./delegationFailure.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret-refused in-place receipt", () => {
  it("records manual cleanup without a patch, anchor, or false revertability", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-secret-receipt-"));
    dirs.push(repo);
    const store = new ArtifactStore(repo, { claudexorDir: join(repo, "runtime") });
    const paths = store.createRun("run-secret-refusal");
    const log = new EventLog(paths.eventsPath, "run-secret-refusal", "task-secret-refusal");
    const run = {
      attemptId: "a01",
      harnessId: "claude",
      label: "Candidate A",
      diff: "",
      gates: [],
      cost: 0,
      errored: true,
      costEstimated: false,
      errors: ["candidate output contains secret-like token; refusing artifact persistence"],
      telemetry: createAttemptTelemetry("auto", false),
      secretDiffRefusal: {
        disposition: "manual_cleanup",
        detail: "postimage diverged; manual cleanup required",
      },
    } satisfies CandidateRun;

    await persistFailedInPlaceWorkProduct({
      live: true,
      run,
      store,
      log,
      paths,
      execRoot: repo,
      preTurnSha: "a".repeat(40),
      taskId: "task-secret-refusal",
      mode: "agent",
      kind: "patch",
    });

    const receipt = readFileSync(join(paths.finalDir, "work_product.yaml"), "utf8");
    expect(receipt).toContain("secret_recovery: manual_cleanup");
    expect(receipt).toContain("adopted: true");
    expect(receipt).toContain("apply_state: applied_review_blocked");
    expect(receipt).toContain("revert_anchor_id: null");
    expect(existsSync(join(paths.finalDir, "patch.diff"))).toBe(false);
    expect(readFileSync(paths.eventsPath, "utf8")).toContain('"manual_cleanup_required":true');
  });
});
