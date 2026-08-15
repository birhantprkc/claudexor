/**
 * Persistent root-authority barrier for a shared data root (issue #165).
 *
 * D1: before ANY journal recovery or destructive startup work, the fixed
 * daemon publishes a permanent, legacy-opaque barrier at the canonical writer
 * address. The barrier is a lease DIRECTORY carrying `root-authority-v2.json`
 * and NO top-level owner.json, so a pre-fix claimant's owner parse fails
 * closed forever — it can neither adopt nor quarantine the address. The
 * barrier is never removed, including on clean shutdown: a failed fixed
 * candidate leaves a protected recovery/offline state instead of reopening
 * the process-reaping race.
 *
 * D2: the barrier record persists two SEPARATE facts — the writer protocol
 * epoch (pre-fix and newer-than-supported epochs are refused) and the
 * semantic version floor of the last fixed runtime that PROVED it could
 * serve (strictly lower fixed versions are refused; equal versions contend
 * normally — build SHA/entry path are evidence, not ordering).
 *
 * D3: an already-running pre-fix contender that passed its dead-owner check
 * before this barrier existed cannot be retroactively revoked — a LIVE flat
 * owner refuses this candidate through the shared lease machinery. Migration
 * of an owned flat generation is an in-place atomic owner replacement: the
 * owner record is atomically swapped for an unparseable migration sentinel,
 * so the address is never absent and never carries a dead parseable owner.
 * This module makes no stronger claim.
 *
 * D4: authority follows the data root. The barrier anchors at the canonical
 * DEFAULT socket address of the daemon root even when the serving socket
 * spelling differs, so every fixed runtime sharing one
 * CLAUDEXOR_CONFIG_DIR/daemon root contends on one root authority.
 *
 * This module builds ON the writer-lease owner (single-writer acquisition,
 * owner classification, stale quarantine) and never re-implements liveness.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentityReader } from "@claudexor/core";
import { compareRuntimeSemver, isRuntimeSemver } from "@claudexor/util";
import { canonicalDefaultSocketPath } from "./token.js";
import {
  acquireDaemonWriterLease,
  writerLeaseAnchorPath,
  ROOT_AUTHORITY_MARKER_FILE,
  type DaemonWriterLease,
  type DaemonWriterLeaseDependencies,
} from "./writer-lease.js";

export const ROOT_AUTHORITY_SCHEMA_VERSION = 2;
/** First fixed writer-protocol epoch. Pre-fix runtimes have no epoch at all;
 * a record with a lower OR higher epoch than this build supports is refused. */
export const ROOT_AUTHORITY_EPOCH = 2;

export interface RootAuthorityRecord {
  schemaVersion: typeof ROOT_AUTHORITY_SCHEMA_VERSION;
  epoch: number;
  /** `vacant` until some fixed runtime proved it could serve this root;
   * `served` afterwards (with `floor` recording that runtime's version). */
  state: "vacant" | "served";
  /** Semantic version of the last fixed runtime that proved it could serve. */
  floor?: string;
}

export type RootAuthorityRefusalCode =
  | "root_authority_unreadable"
  | "root_authority_epoch_unsupported"
  | "root_authority_floor_regression";

function rootAuthorityRefusal(
  code: RootAuthorityRefusalCode,
  message: string,
): Error & { code: RootAuthorityRefusalCode; status: number } {
  return Object.assign(new Error(message), { code, status: 409 });
}

export type RootAuthorityStatus =
  | { status: "absent"; markerPath: string }
  | { status: "valid"; markerPath: string; record: RootAuthorityRecord }
  | { status: "invalid"; markerPath: string; reason: string };

function parseRootAuthorityRecord(raw: string): RootAuthorityRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "marker is not valid JSON";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "marker is not a JSON object";
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ROOT_AUTHORITY_SCHEMA_VERSION) {
    return `marker schemaVersion is not ${ROOT_AUTHORITY_SCHEMA_VERSION}`;
  }
  if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) <= 0) {
    return "marker epoch is not a positive integer";
  }
  if (record.state !== "vacant" && record.state !== "served") {
    return "marker state is not vacant/served";
  }
  if (record.floor !== undefined && !isRuntimeSemver(record.floor)) {
    return "marker floor is not an x.y.z semver";
  }
  return {
    schemaVersion: ROOT_AUTHORITY_SCHEMA_VERSION,
    epoch: record.epoch as number,
    state: record.state,
    ...(record.floor !== undefined ? { floor: record.floor as string } : {}),
  };
}

/** Fail-closed barrier read: only a physically missing marker is `absent`. */
export function readRootAuthority(anchorPath: string): RootAuthorityStatus {
  const markerPath = join(anchorPath, ROOT_AUTHORITY_MARKER_FILE);
  let raw: string;
  try {
    const stat = lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { status: "invalid", markerPath, reason: "marker is not a regular file" };
    }
    raw = readFileSync(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "absent", markerPath };
    }
    return { status: "invalid", markerPath, reason: "marker is unreadable" };
  }
  const record = parseRootAuthorityRecord(raw);
  if (typeof record === "string") return { status: "invalid", markerPath, reason: record };
  return { status: "valid", markerPath, record };
}

/** D2 admission: refuse foreign epochs and strictly lower semantic versions. */
export function assertRootAuthorityAdmits(record: RootAuthorityRecord, version: string): void {
  if (record.epoch !== ROOT_AUTHORITY_EPOCH) {
    throw rootAuthorityRefusal(
      "root_authority_epoch_unsupported",
      record.epoch < ROOT_AUTHORITY_EPOCH
        ? `root authority epoch ${record.epoch} predates the supported writer epoch ${ROOT_AUTHORITY_EPOCH}`
        : `root authority epoch ${record.epoch} is newer than the supported writer epoch ${ROOT_AUTHORITY_EPOCH}`,
    );
  }
  if (record.floor === undefined) return;
  if (!isRuntimeSemver(version)) {
    // Fail closed: a candidate that cannot be ORDERED against the proven
    // floor cannot prove it is not a regression.
    throw rootAuthorityRefusal(
      "root_authority_floor_regression",
      `candidate version '${version}' cannot be ordered against the proven serving floor ${record.floor}`,
    );
  }
  if (compareRuntimeSemver(version, record.floor) < 0) {
    throw rootAuthorityRefusal(
      "root_authority_floor_regression",
      `candidate version ${version} is below the proven serving floor ${record.floor}`,
    );
  }
}

/** Atomic (tmp + rename), link-refusing marker write inside the barrier dir. */
function writeRootAuthorityRecord(anchorPath: string, record: RootAuthorityRecord): void {
  const markerPath = join(anchorPath, ROOT_AUTHORITY_MARKER_FILE);
  const temp = join(anchorPath, `.${ROOT_AUTHORITY_MARKER_FILE}.${process.pid}-${randomUUID()}`);
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, markerPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface RootAuthorityGrant {
  /** The daemon's operational writer lease (socket-adjacent address). */
  readonly lease: DaemonWriterLease;
  /** The barrier record that admitted this candidate. */
  readonly record: RootAuthorityRecord;
  /** Barrier anchor directory (also the canonical lease anchor). */
  readonly anchorPath: string;
  /** D5 stage 4: persist that this exact runtime PROVED it could serve.
   * Monotonic — never lowers an existing floor. Returns the stored record. */
  advanceFloor(): RootAuthorityRecord;
  /** Release the live writer claim(s). The barrier itself persists (D1). */
  release(): void;
}

export interface AcquireRootAuthorityInput {
  socketPath: string;
  /** Candidate's semantic runtime version (engine build identity). */
  version: string;
  identity?: ProcessIdentityReader;
  deps?: Omit<DaemonWriterLeaseDependencies, "identity">;
  /** Test seam: canonical default endpoint of this data root. */
  canonicalSocketPath?: string;
}

/** Migration sentinel that atomically replaces the owned flat owner record.
 * It parses as NO lease owner anywhere (no pid/token), so from the instant it
 * lands, pre-fix AND fixed claimants alike fail closed on the flat address;
 * only this module recognizes it and completes the interrupted migration. */
const MIGRATION_SENTINEL = { rootAuthority: "migrating" } as const;

function isMigrationSentinel(anchorPath: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(anchorPath, "owner.json"), "utf8")) as {
      rootAuthority?: unknown;
    };
    return value?.rootAuthority === MIGRATION_SENTINEL.rootAuthority;
  } catch {
    return false;
  }
}

/** Publish the marker over an already-neutralized generation, then retire the
 * sentinel. Every intermediate state keeps the address occupied and opaque. */
function completeBarrierInstallation(anchorPath: string): void {
  writeRootAuthorityRecord(anchorPath, {
    schemaVersion: ROOT_AUTHORITY_SCHEMA_VERSION,
    epoch: ROOT_AUTHORITY_EPOCH,
    state: "vacant",
  });
  rmSync(join(anchorPath, "owner.json"), { force: true });
}

/**
 * Stage-1 startup admission: validate/install the permanent barrier, apply
 * the epoch + floor refusals, and claim single-writer authority for this
 * root. On a barrier-less root the flat legacy address is claimed through
 * the shared lease machinery first (live owners refuse, proven-stale owners
 * are quarantined), then the owned generation becomes the barrier in place:
 * owner record atomically swapped for the migration sentinel, marker
 * published, sentinel retired, claim reacquired in the nested slot.
 */
export function acquireRootAuthority(input: AcquireRootAuthorityInput): RootAuthorityGrant {
  const canonical = input.canonicalSocketPath ?? canonicalDefaultSocketPath();
  const anchorPath = writerLeaseAnchorPath(canonical);
  const acquireClaim = (socketPath: string): DaemonWriterLease =>
    acquireDaemonWriterLease(socketPath, { identity: input.identity }, input.deps ?? {});

  const before = readRootAuthority(anchorPath);
  if (before.status === "invalid") {
    throw rootAuthorityRefusal(
      "root_authority_unreadable",
      `root authority barrier at ${before.markerPath} is unusable (${before.reason}); refusing to serve this data root`,
    );
  }
  let record: RootAuthorityRecord | null = null;
  if (before.status === "valid") {
    assertRootAuthorityAdmits(before.record, input.version);
    record = before.record;
  } else if (isMigrationSentinel(anchorPath)) {
    // A previous fixed candidate crashed between neutralizing the owner and
    // publishing the marker. The address stayed opaque throughout; finish the
    // interrupted installation deterministically.
    completeBarrierInstallation(anchorPath);
  }

  // Claim the canonical root address. With a barrier installed the lease
  // machinery resolves the nested active slot; without one it wins (or
  // refuses with the shared typed errors) the flat legacy address.
  let rootClaim = acquireClaim(canonical);
  if (rootClaim.path === anchorPath) {
    // First migration (D1/D3): we own the FLAT generation with a live owner
    // record. Convert it in place — the directory never disappears and its
    // owner record is either this live pid or the unparseable sentinel, so a
    // pre-fix claimant fails closed at every instant.
    try {
      const temp = join(anchorPath, `.owner.json.${process.pid}-${randomUUID()}`);
      writeFileSync(temp, `${JSON.stringify(MIGRATION_SENTINEL)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, join(anchorPath, "owner.json"));
      completeBarrierInstallation(anchorPath);
    } catch (error) {
      throw rootAuthorityRefusal(
        "root_authority_unreadable",
        `root authority barrier could not be installed at ${anchorPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    rootClaim = acquireClaim(canonical);
  }
  if (record === null) {
    const installed = readRootAuthority(anchorPath);
    if (installed.status !== "valid") {
      rootClaim.release();
      throw rootAuthorityRefusal(
        "root_authority_unreadable",
        `root authority barrier at ${anchorPath} did not settle after installation`,
      );
    }
    try {
      assertRootAuthorityAdmits(installed.record, input.version);
    } catch (error) {
      rootClaim.release();
      throw error;
    }
    record = installed.record;
  }

  // D4: a custom socket spelling still serves under the canonical root
  // authority; its own socket-adjacent lease is claimed in addition.
  const socketLease = input.socketPath === canonical ? null : acquireClaim(input.socketPath);
  const lease = socketLease ?? rootClaim;
  let released = false;
  return {
    lease,
    record,
    anchorPath,
    advanceFloor: () => {
      const current = readRootAuthority(anchorPath);
      const floor =
        current.status === "valid" &&
        current.record.floor !== undefined &&
        (!isRuntimeSemver(input.version) ||
          compareRuntimeSemver(current.record.floor, input.version) >= 0)
          ? current.record.floor
          : isRuntimeSemver(input.version)
            ? input.version
            : undefined;
      const next: RootAuthorityRecord = {
        schemaVersion: ROOT_AUTHORITY_SCHEMA_VERSION,
        epoch: ROOT_AUTHORITY_EPOCH,
        state: "served",
        ...(floor !== undefined ? { floor } : {}),
      };
      writeRootAuthorityRecord(anchorPath, next);
      return next;
    },
    release: () => {
      if (released) return;
      released = true;
      socketLease?.release();
      rootClaim.release();
    },
  };
}
