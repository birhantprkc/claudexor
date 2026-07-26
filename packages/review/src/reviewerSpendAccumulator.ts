import type { CostKnowledge } from "@claudexor/schema";
import {
  summarizeReviewerSpend,
  type ReviewerOutput,
  type ReviewCandidateResult,
} from "./reviewRuntimeTypes.js";

export interface PartialReviewerSpend {
  partialCostUsd?: number;
  partialCostEstimated?: boolean;
  partialCashUsd?: number;
  partialCashKnowledge?: CostKnowledge;
  partialValuationUsd?: number;
  partialValuationKnowledge?: CostKnowledge;
  partialUnknownUsd?: number;
}

/** Input-ordered panel accounting, kept separate from review orchestration. */
export class ReviewerSpendAccumulator {
  private readonly spend: number[];
  private readonly estimated: boolean[];
  private readonly cash: number[];
  private readonly cashKnowledge: CostKnowledge[];
  private readonly valuation: number[];
  private readonly valuationKnowledge: CostKnowledge[];
  private readonly unknown: number[];

  constructor(size: number) {
    this.spend = Array(size).fill(0);
    this.estimated = Array(size).fill(false);
    this.cash = Array(size).fill(0);
    this.cashKnowledge = Array(size).fill("unknown");
    this.valuation = Array(size).fill(0);
    this.valuationKnowledge = Array(size).fill("unknown");
    this.unknown = Array(size).fill(0);
  }

  record(index: number, output: ReviewerOutput): void {
    this.spend[index] = output.costUsd;
    this.estimated[index] = output.costEstimated;
    this.cash[index] = output.cashUsd;
    this.cashKnowledge[index] = output.cashKnowledge;
    this.valuation[index] = output.valuationUsd;
    this.valuationKnowledge[index] = output.valuationKnowledge;
    this.unknown[index] = output.unknownUsd;
  }

  recordPartial(index: number, output: PartialReviewerSpend): void {
    const hasCost =
      typeof output.partialCostUsd === "number" &&
      Number.isFinite(output.partialCostUsd) &&
      output.partialCostUsd >= 0;
    const hasComponentKnowledge =
      output.partialCashKnowledge !== undefined || output.partialValuationKnowledge !== undefined;
    if (!hasCost && !hasComponentKnowledge) return;
    this.spend[index] = hasCost ? (output.partialCostUsd ?? 0) : 0;
    this.estimated[index] = output.partialCostEstimated === true;
    this.cash[index] = output.partialCashUsd ?? 0;
    this.cashKnowledge[index] = output.partialCashKnowledge ?? "unknown";
    this.valuation[index] = output.partialValuationUsd ?? 0;
    this.valuationKnowledge[index] = output.partialValuationKnowledge ?? "unknown";
    this.unknown[index] = output.partialUnknownUsd ?? 0;
  }

  summary(): Pick<
    ReviewCandidateResult,
    | "reviewSpendUsd"
    | "reviewSpendEstimated"
    | "reviewCashUsd"
    | "reviewCashKnowledge"
    | "reviewValuationUsd"
    | "reviewValuationKnowledge"
    | "reviewUnknownUsd"
  > {
    return summarizeReviewerSpend(
      this.spend,
      this.cash,
      this.valuation,
      this.unknown,
      this.estimated,
      this.cashKnowledge,
      this.valuationKnowledge,
    );
  }
}
