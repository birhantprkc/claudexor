import { assertOnlyQueryParams, optionalBooleanQuery, singleQuery } from "./query.js";
import {
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
} from "@claudexor/schema";

export interface HarnessListQuery {
  fresh?: boolean;
  includeFakes?: boolean;
  harnessIds?: string[];
}

export function parseHarnessListQuery(url: URL): HarnessListQuery {
  assertOnlyQueryParams(url, ["fresh", "all", "harness"]);
  const fresh = optionalBooleanQuery(url, "fresh");
  const includeFakes = optionalBooleanQuery(url, "all");
  const harnessValues = url.searchParams.getAll("harness");
  if (harnessValues.some((id) => id.trim().length === 0)) {
    throw new Error("harness query parameters must be non-empty");
  }
  const harnessIds = harnessValues.map((id) => id.trim());
  return {
    ...(fresh === undefined ? {} : { fresh }),
    ...(includeFakes === undefined ? {} : { includeFakes }),
    ...(harnessIds.length === 0 ? {} : { harnessIds }),
  };
}

export function parseCredentialProfilesSnapshotQuery(url: URL) {
  assertOnlyQueryParams(url, ["snapshot"]);
  const snapshot = optionalBooleanQuery(url, "snapshot") ?? false;
  return {
    input: { snapshot },
    schema: snapshot
      ? ControlCredentialProfilesSnapshotResponse
      : ControlCredentialProfilesResponse,
  };
}

export function parseRunApplicabilityQuery(url: URL): { repoRoot: string } {
  assertOnlyQueryParams(url, ["repoRoot"]);
  const repoRoot = singleQuery(url, "repoRoot");
  if (repoRoot === undefined || repoRoot.trim().length === 0) {
    throw new Error("repoRoot query parameter is required");
  }
  return { repoRoot };
}
