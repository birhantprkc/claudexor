import { summarizeDiffPaths } from "@claudexor/core";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import { revertWorkingTreePatch, type WorkspaceManager } from "@claudexor/workspace";
import { containsSecretLikeToken, redactSecrets } from "@claudexor/util";
import { candidateOutputsContainSecret, rasterLinksInMarkdown } from "./candidateOutputs.js";

export interface SecretDiffRefusal {
  disposition: "discarded" | "reverted" | "manual_cleanup";
  detail: string;
}

export function recordSecretDiffRefusal(
  refusal: SecretDiffRefusal | undefined,
  errors: string[],
  existingError: boolean,
): boolean {
  if (!refusal) return existingError;
  errors.push("candidate output could not be proven secret-safe; refusing artifact persistence");
  return true;
}

export function secretDiffNextActions(refusal: SecretDiffRefusal): string[] {
  return refusal.disposition === "manual_cleanup"
    ? ["Inspect and clean the in-place project state manually", "Retry the run"]
    : ["Retry the run without writing secret material"];
}

/** Keep a secret-bearing patch memory-only. Isolated bytes die with their
 * envelope; in-place bytes are removed only through the existing exact
 * postimage check, so a concurrent edit turns into manual cleanup rather than
 * a destructive rollback. */
export async function quarantineSecretDiff(input: {
  diff: string;
  inPlace: boolean;
  repo: string;
  binarySecretLike: boolean;
  gitBacked: boolean;
}): Promise<{ diff: string; refusal?: SecretDiffRefusal }> {
  if (!containsSecretLikeToken(input.diff) && !input.binarySecretLike) {
    return { diff: input.diff };
  }
  if (!input.inPlace) {
    return {
      diff: "",
      refusal: {
        disposition: "discarded",
        detail:
          "isolated candidate bytes that could not be proven secret-safe were discarded with the candidate envelope",
      },
    };
  }
  if (input.binarySecretLike && !input.diff.trim()) {
    return {
      diff: "",
      refusal: {
        disposition: "manual_cleanup",
        detail:
          "candidate output could not be proven secret-safe or captured as an exact reversible patch; manual cleanup required",
      },
    };
  }
  let rollback;
  try {
    rollback = await revertWorkingTreePatch(input.repo, input.diff, {
      isolateObjectWrites: input.gitBacked,
      noIndex: !input.gitBacked,
    });
  } catch {
    return {
      diff: "",
      refusal: {
        disposition: "manual_cleanup",
        detail:
          "in-place output that could not be proven secret-safe could not be rolled back; manual cleanup required",
      },
    };
  }
  const manuallyClean = !rollback.reverted || input.gitBacked;
  return {
    diff: "",
    refusal: !manuallyClean
      ? {
          disposition: "reverted",
          detail:
            "in-place bytes that could not be proven secret-safe were removed by an exact checked rollback",
        }
      : {
          disposition: "manual_cleanup",
          detail: redactSecrets(
            rollback.reverted && input.gitBacked
              ? "worktree bytes were removed; inspect Git index, refs, and objects for harness-written secret state"
              : (rollback.reason ??
                  "secret-bearing in-place bytes changed before rollback; manual cleanup required"),
          ),
        },
  };
}

export async function quarantineCandidateWorkspace(
  wsm: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  inPlace: boolean,
  answerText?: string,
): ReturnType<typeof quarantineSecretDiff> {
  let captured;
  try {
    captured = await wsm.captureDiff(envelope);
  } catch {
    return {
      diff: "",
      refusal: {
        disposition: inPlace ? "manual_cleanup" : "discarded",
        detail: inPlace
          ? "candidate output could not be captured safely; manual cleanup required"
          : "uncaptured isolated candidate output was discarded with the candidate envelope",
      },
    };
  }
  const mediaSecretLike = candidateOutputsContainSecret({
    worktreePath: envelope.worktree_path,
    changedPaths: [
      ...summarizeDiffPaths(captured.diff).paths,
      ...rasterLinksInMarkdown(answerText ?? ""),
    ],
  });
  return quarantineSecretDiff({
    diff: captured.diff,
    binarySecretLike: captured.binarySecretLike || mediaSecretLike,
    repo: envelope.worktree_path,
    inPlace,
    gitBacked: Boolean(envelope.base_sha),
  });
}
