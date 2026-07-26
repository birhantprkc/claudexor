import type { CostKnowledge } from "@claudexor/schema";
import type { ReviewerAuthMode } from "./reviewRuntimeTypes.js";

/** Tracks certainty independently for billed cash and subscription valuation. */
export class ReviewerCostKnowledge {
  private sawNativeRoute = false;
  private sawApiRoute = false;
  private sawNativeUsage = false;
  private sawUnknownUsage = false;
  private apiUsageEstimated = false;
  private nativeUsageEstimated = false;
  private unresolvedApiRoute = false;
  private unresolvedUndisclosedRoute = false;
  private activeSawEvent = false;
  private activeSawNativeRoute = false;
  private activeSawApiRoute = false;
  private activeSawApiUsage = false;

  startAttempt(): void {
    this.activeSawEvent = false;
    this.activeSawNativeRoute = false;
    this.activeSawApiRoute = false;
    this.activeSawApiUsage = false;
  }

  observeEvent(route: ReviewerAuthMode): void {
    this.activeSawEvent = true;
    if (route === "local_session") {
      this.sawNativeRoute = true;
      this.activeSawNativeRoute = true;
    } else if (route === "api_key") {
      this.sawApiRoute = true;
      this.activeSawApiRoute = true;
    }
  }

  observeUsage(route: ReviewerAuthMode, estimated: boolean): void {
    if (route === "local_session") {
      this.sawNativeUsage = true;
      this.nativeUsageEstimated ||= estimated;
    } else if (route === "api_key") {
      this.activeSawApiUsage = true;
      this.apiUsageEstimated ||= estimated;
    } else {
      this.sawUnknownUsage = true;
    }
  }

  finishAttempt(): void {
    if (this.activeSawApiRoute && !this.activeSawApiUsage) this.unresolvedApiRoute = true;
    if (this.activeSawEvent && !this.activeSawNativeRoute && !this.activeSawApiRoute) {
      this.unresolvedUndisclosedRoute = true;
    }
  }

  snapshot(): { cashKnowledge: CostKnowledge; valuationKnowledge: CostKnowledge } {
    const unresolvedActiveApi = this.activeSawApiRoute && !this.activeSawApiUsage;
    const unresolvedActiveRoute =
      this.activeSawEvent && !this.activeSawNativeRoute && !this.activeSawApiRoute;
    const cashUnknown =
      this.sawUnknownUsage ||
      this.unresolvedApiRoute ||
      unresolvedActiveApi ||
      this.unresolvedUndisclosedRoute ||
      unresolvedActiveRoute ||
      (!this.sawNativeRoute && !this.sawApiRoute);
    return {
      cashKnowledge: cashUnknown ? "unknown" : this.apiUsageEstimated ? "estimated" : "exact",
      valuationKnowledge: this.sawUnknownUsage
        ? "unknown"
        : this.sawNativeUsage
          ? this.nativeUsageEstimated
            ? "estimated"
            : "exact"
          : "unknown",
    };
  }
}
