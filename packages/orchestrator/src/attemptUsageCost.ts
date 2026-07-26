export interface AttemptUsageCost {
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
  cashEstimated: boolean;
  valuationEstimated: boolean;
}

export function newAttemptUsageCost(): AttemptUsageCost {
  return {
    cashUsd: 0,
    valuationUsd: 0,
    unknownUsd: 0,
    cashEstimated: false,
    valuationEstimated: false,
  };
}

export function recordAttemptUsageCost(
  cost: AttemptUsageCost,
  mode: "local_session" | "api_key" | null,
  usd: number,
  estimated: boolean,
): void {
  if (mode === "local_session") {
    cost.valuationUsd += usd;
    cost.valuationEstimated ||= estimated;
  } else if (mode === "api_key") {
    cost.cashUsd += usd;
    cost.cashEstimated ||= estimated;
  } else {
    cost.unknownUsd += usd;
  }
}
