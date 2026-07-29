import { join } from "node:path";
import { readTextSafe } from "@claudexor/util";
import type {
  ControlPrimaryOutput,
  ModeKind,
  RunFailure,
  RunOutcomeFacts,
} from "@claudexor/schema";

export interface CliPrimaryOutput {
  kind: ControlPrimaryOutput["kind"];
  path: string;
  text: string;
}

interface CliPrimaryOutputCandidate {
  kind: ControlPrimaryOutput["kind"];
  path: string;
}

export function primaryOutputCandidatesForCli(mode?: ModeKind): CliPrimaryOutputCandidate[] {
  return mode === "ask"
    ? [
        { kind: "answer", path: "final/answer.md" },
        // deep scan writes a synthesized research report instead of an answer
        { kind: "report", path: "final/report.md" },
      ]
    : mode === "plan"
      ? [{ kind: "plan", path: "final/plan.md" }]
      : [
          { kind: "answer", path: "final/answer.md" },
          { kind: "patch", path: "final/patch.diff" },
        ];
}

export interface CliPrimaryOutputContext {
  failure?: RunFailure | null;
  lifecycle?: RunOutcomeFacts["lifecycle"];
}

export function primaryOutputForCli(
  root: string,
  mode?: ModeKind,
  context: CliPrimaryOutputContext = {},
): CliPrimaryOutput | null {
  for (const candidate of primaryOutputCandidatesForCli(mode)) {
    const text = readTextSafe(join(root, candidate.path));
    if (text?.trim()) return { ...candidate, text };
  }
  if (mode === "ask" && context.lifecycle === "cancelled") {
    const text = readTextSafe(join(root, "final/summary.md"));
    if (text?.trim()) return { kind: "diagnostic", path: "final/summary.md", text };
  }
  if (context.failure) {
    return {
      kind: "diagnostic",
      path: context.failure.rawDetailRef ?? "final/failure.yaml",
      text: context.failure.safeMessage,
    };
  }
  const failure = readTextSafe(join(root, "final/failure.yaml"));
  return failure?.trim() ? { kind: "diagnostic", path: "final/failure.yaml", text: failure } : null;
}
