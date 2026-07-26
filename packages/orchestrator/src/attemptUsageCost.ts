import type { CostKnowledge, HarnessEvent } from "@claudexor/schema";
import { unknownCostSettlement, type BudgetSettlement } from "@claudexor/budget";

export interface AttemptUsageCost {
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
  cashEstimated: boolean;
  valuationEstimated: boolean;
  readonly cashKnowledge?: CostKnowledge;
  readonly valuationKnowledge?: CostKnowledge;
}

interface RouteKnowledgeState {
  sawNativeRoute: boolean;
  sawApiRoute: boolean;
  sawNativeUsage: boolean;
  sawUnknownUsage: boolean;
  unresolvedApiRoute: boolean;
  unresolvedUndisclosedRoute: boolean;
  activeSawEvent: boolean;
  activeSawNativeRoute: boolean;
  activeSawApiRoute: boolean;
  activeSawApiUsage: boolean;
}

const routeKnowledge = new WeakMap<AttemptUsageCost, RouteKnowledgeState>();

export interface AttemptFailureCost {
  totalUsd: number;
  estimated: boolean;
  settlement: BudgetSettlement;
}

export class AttemptPostStreamError extends Error {
  constructor(
    cause: unknown,
    readonly attemptCost: AttemptFailureCost,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AttemptPostStreamError";
  }
}

/** Preserve already-observed route-specific spend across fallible persistence. */
export function withAttemptFailureCost<T>(work: () => T, attemptCost: AttemptFailureCost): T {
  try {
    return work();
  } catch (error) {
    throw new AttemptPostStreamError(error, attemptCost);
  }
}

/** Settle every lease owner from the same post-stream error truth. */
export function attemptFailureCost(
  error: unknown,
  fallbackSource: string,
  fallbackCashUsd?: number,
): AttemptFailureCost {
  if (error instanceof AttemptPostStreamError) return error.attemptCost;
  const carriedCashUsd =
    typeof (error as { costUsd?: unknown })?.costUsd === "number" &&
    Number.isFinite((error as { costUsd: number }).costUsd) &&
    (error as { costUsd: number }).costUsd >= 0
      ? (error as { costUsd: number }).costUsd
      : fallbackCashUsd;
  return {
    totalUsd: carriedCashUsd ?? 0,
    estimated: true,
    settlement: unknownCostSettlement(fallbackSource, carriedCashUsd),
  };
}

export function newAttemptUsageCost(): AttemptUsageCost {
  const cost: AttemptUsageCost = {
    cashUsd: 0,
    valuationUsd: 0,
    unknownUsd: 0,
    cashEstimated: false,
    valuationEstimated: false,
  };
  routeKnowledge.set(cost, newRouteKnowledgeState());
  Object.defineProperties(cost, {
    cashKnowledge: { enumerable: false, get: () => attemptUsageCostKnowledge(cost).cash },
    valuationKnowledge: {
      enumerable: false,
      get: () => attemptUsageCostKnowledge(cost).valuation,
    },
  });
  return cost;
}

/** A harness retry starts a new route-proof interval. An API interval that
 * ended without a usage receipt remains unresolved even if a later retry pays. */
function startAttemptUsageRoute(cost: AttemptUsageCost): void {
  const state = stateFor(cost);
  finishActiveRoute(state);
  state.activeSawEvent = false;
  state.activeSawNativeRoute = false;
  state.activeSawApiRoute = false;
  state.activeSawApiUsage = false;
}

function observeAttemptUsageRoute(
  cost: AttemptUsageCost,
  mode: "local_session" | "api_key" | null,
): void {
  const state = stateFor(cost);
  state.activeSawEvent = true;
  if (mode === "local_session") {
    state.sawNativeRoute = true;
    state.activeSawNativeRoute = true;
  } else if (mode === "api_key") {
    state.sawApiRoute = true;
    state.activeSawApiRoute = true;
  }
}

/** Observe one event and return the route to carry into the next event. */
export function observeAttemptUsageEvent(
  cost: AttemptUsageCost,
  event: HarnessEvent,
  previousMode: "local_session" | "api_key" | null,
): "local_session" | "api_key" | null {
  let mode = event.type === "started" ? null : previousMode;
  if (event.type === "started") startAttemptUsageRoute(cost);
  if (event.credential_route === "vendor_native") mode = "local_session";
  else if (event.credential_route === "managed_api_key") mode = "api_key";
  if (event.type === "message" && event.payload?.["auth_switched"] === true) {
    if (event.payload["to_auth_mode"] === "subscription") mode = "local_session";
    else if (event.payload["to_auth_mode"] === "api_key") mode = "api_key";
  }
  observeAttemptUsageRoute(cost, mode);
  const usd = event.usage?.cost_usd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
    const receiptMode =
      event.credential_route === "vendor_native"
        ? "local_session"
        : event.credential_route === "managed_api_key"
          ? "api_key"
          : mode;
    recordAttemptUsageCost(cost, receiptMode, usd, event.usage?.estimated === true);
  }
  return mode;
}

export function recordAttemptUsageCost(
  cost: AttemptUsageCost,
  mode: "local_session" | "api_key" | null,
  usd: number,
  estimated: boolean,
): void {
  const state = stateFor(cost);
  if (mode === "local_session") {
    state.sawNativeUsage = true;
    cost.valuationUsd += usd;
    cost.valuationEstimated ||= estimated;
  } else if (mode === "api_key") {
    state.activeSawApiUsage = true;
    cost.cashUsd += usd;
    cost.cashEstimated ||= estimated;
  } else {
    state.sawUnknownUsage = true;
    cost.unknownUsd += usd;
  }
}

function attemptUsageCostKnowledge(cost: AttemptUsageCost): {
  cash: CostKnowledge;
  valuation: CostKnowledge;
} {
  const state = stateFor(cost);
  const cashUnknown =
    state.sawUnknownUsage ||
    state.unresolvedApiRoute ||
    state.unresolvedUndisclosedRoute ||
    (state.activeSawApiRoute && !state.activeSawApiUsage) ||
    (state.activeSawEvent && !state.activeSawNativeRoute && !state.activeSawApiRoute) ||
    (!state.sawNativeRoute && !state.sawApiRoute);
  return {
    cash: cashUnknown ? "unknown" : cost.cashEstimated ? "estimated" : "exact",
    valuation: state.sawUnknownUsage
      ? "unknown"
      : state.sawNativeUsage
        ? cost.valuationEstimated
          ? "estimated"
          : "exact"
        : "unknown",
  };
}

function finishActiveRoute(state: RouteKnowledgeState): void {
  if (state.activeSawApiRoute && !state.activeSawApiUsage) state.unresolvedApiRoute = true;
  if (state.activeSawEvent && !state.activeSawNativeRoute && !state.activeSawApiRoute) {
    state.unresolvedUndisclosedRoute = true;
  }
}

function stateFor(cost: AttemptUsageCost): RouteKnowledgeState {
  let state = routeKnowledge.get(cost);
  if (!state) {
    state = newRouteKnowledgeState();
    routeKnowledge.set(cost, state);
  }
  return state;
}

function newRouteKnowledgeState(): RouteKnowledgeState {
  return {
    sawNativeRoute: false,
    sawApiRoute: false,
    sawNativeUsage: false,
    sawUnknownUsage: false,
    unresolvedApiRoute: false,
    unresolvedUndisclosedRoute: false,
    activeSawEvent: false,
    activeSawNativeRoute: false,
    activeSawApiRoute: false,
    activeSawApiUsage: false,
  };
}
