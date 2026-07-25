/**
 * Revise prompt for a convergence attempt that did not converge.
 *
 * Extracted from the loop body rather than inlined: the repair instruction is
 * a contract (three legitimate moves, a per-finding accounting line, and an
 * order of work), and an inline template literal both hides it from tests and
 * grows the orchestrator god-file. Pure string building — no state.
 *
 * Naming all three moves is what stops a do-nothing resubmit, but only "fix"
 * moves the loop: rebuttals and unreachability declarations are not persisted
 * as a channel and nothing adjudicates them. The contract says so out loud
 * instead of implying an arbiter that does not exist — the accounting rides in
 * the attempt's own output, where a human reading the run artifacts sees it.
 */
import type { ReviewFinding } from "@claudexor/schema";
import { formatFindings } from "./runSupport.js";

export function buildRevisePrompt(
  basePrompt: string,
  findings: ReviewFinding[],
  runtimeErrors: string,
): string {
  const contract = [
    "The previous attempt did not converge. Each finding below has exactly three legitimate moves: fix it, rebut it with evidence showing the finding is wrong, or state that it is unreachable in this environment and name the concrete gap. Re-emitting the same work with none of those three changes nothing and will not converge.",
    "Only a fix changes what the next review sees. There is no rebuttal channel and nothing adjudicates a rebuttal or an unreachability declaration today: both live only in this attempt's own output, preserved in the run artifacts for a human who reads them. Write them for that reader, and expect the next review to look at the changed work rather than at your argument about the last round.",
    "A finding is a hypothesis with an argument attached. Check that argument against the code before you act on it. An argument that does not survive checking must be rebutted, not complied with: complying with a disproved finding introduces a real defect.",
    "Do not patch findings one at a time. Re-read the whole diff first, group the findings by root cause, and only then act.",
    "Before the deliverable, write one short line per finding: which of the three moves you took and the concrete evidence for it, meaning a file and line, a symbol, or a test name. That accounting rides in this attempt's output and goes no further on its own.",
    "",
    "Review findings:",
    formatFindings(findings),
  ].join("\n");
  return `${basePrompt}\n\n${contract}${runtimeErrors}`;
}
