import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readTextSafe } from "@claudexor/util";
import type {
  ControlPrimaryOutput,
  ModeKind,
  RunFailure,
  RunOutcomeFacts,
  RunPresentationFacts,
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
  presentation?: RunPresentationFacts;
}

function presentationArtifactText(root: string, path: string): string | null {
  try {
    if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) return null;
    const parts = path.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const canonicalRoot = realpathSync(root);
    const absolute = resolve(canonicalRoot, path);
    const rel = relative(canonicalRoot, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const real = realpathSync(absolute);
    const realRel = relative(canonicalRoot, real);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return null;
    return readTextSafe(real);
  } catch {
    return null;
  }
}

export function primaryOutputForCli(
  root: string,
  mode?: ModeKind,
  context: CliPrimaryOutputContext = {},
): CliPrimaryOutput | null {
  if (context.presentation) {
    const primary = context.presentation.primary;
    if (!primary) return null;
    const text = presentationArtifactText(root, primary.path);
    return text?.trim() ? { ...primary, text } : null;
  }
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
