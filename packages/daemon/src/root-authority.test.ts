import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRootAuthority,
  assertRootAuthorityAdmits,
  readRootAuthority,
  ROOT_AUTHORITY_EPOCH,
  type RootAuthorityRecord,
} from "./root-authority.js";
import {
  acquireDaemonWriterLease,
  inspectDaemonWriterLease,
  writerLeaseAnchorPath,
  writerLeasePath,
  ROOT_AUTHORITY_MARKER_FILE,
} from "./writer-lease.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempSocket(): { socketPath: string; anchor: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "claudexor-root-authority-"));
  roots.push(root);
  const socketPath = join(root, "claudexord.sock");
  const anchor = writerLeaseAnchorPath(socketPath);
  return { socketPath, anchor, marker: join(anchor, ROOT_AUTHORITY_MARKER_FILE) };
}

function writeMarker(anchor: string, record: Record<string, unknown>): void {
  mkdirSync(anchor, { recursive: true, mode: 0o700 });
  writeFileSync(join(anchor, ROOT_AUTHORITY_MARKER_FILE), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

function grantFor(socketPath: string, version: string) {
  return acquireRootAuthority({ socketPath, version, canonicalSocketPath: socketPath });
}

describe("root authority barrier installation", () => {
  it("installs the permanent opaque barrier on a barrier-less root and claims the nested slot", () => {
    const { socketPath, anchor, marker } = tempSocket();
    const grant = grantFor(socketPath, "3.4.0");
    const record = JSON.parse(readFileSync(marker, "utf8")) as RootAuthorityRecord;
    expect(record).toEqual({ schemaVersion: 2, epoch: ROOT_AUTHORITY_EPOCH, state: "vacant" });
    // The barrier carries NO top-level owner record a pre-fix parse could use.
    expect(() => readFileSync(join(anchor, "owner.json"))).toThrow();
    // The live claim moved to the nested slot behind the barrier.
    expect(grant.lease.path).toBe(join(anchor, "active.writer"));
    expect(JSON.parse(readFileSync(join(grant.lease.path, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    grant.release();
  });

  it("converts an owned stale flat legacy lease in place (D3 first migration)", () => {
    const { socketPath, anchor, marker } = tempSocket();
    // A dead pre-fix owner: flat directory with a parseable owner.json whose
    // pid can no longer exist.
    mkdirSync(anchor, { recursive: true, mode: 0o700 });
    writeFileSync(join(anchor, "owner.json"), '{"pid":2147483646,"token":"legacy"}\n', {
      mode: 0o600,
    });
    const grant = grantFor(socketPath, "3.4.0");
    expect(readRootAuthority(anchor).status).toBe("valid");
    expect(() => readFileSync(join(anchor, "owner.json"))).toThrow();
    expect(grant.lease.path).toBe(join(anchor, "active.writer"));
    expect(marker).toContain(anchor);
    grant.release();
  });

  it("refuses while a live flat legacy owner holds the address", () => {
    const { socketPath, anchor } = tempSocket();
    mkdirSync(anchor, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(anchor, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "live-legacy" })}\n`,
      { mode: 0o600 },
    );
    expect(() => grantFor(socketPath, "3.4.0")).toThrow(
      expect.objectContaining({ code: "daemon_writer_busy" }),
    );
    // The live owner's record was not disturbed.
    expect(JSON.parse(readFileSync(join(anchor, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
      token: "live-legacy",
    });
  });

  it("completes an interrupted migration whose owner record is the sentinel", () => {
    const { socketPath, anchor } = tempSocket();
    mkdirSync(anchor, { recursive: true, mode: 0o700 });
    writeFileSync(join(anchor, "owner.json"), '{"rootAuthority":"migrating"}\n', { mode: 0o600 });
    const grant = grantFor(socketPath, "3.4.0");
    expect(readRootAuthority(anchor)).toMatchObject({
      status: "valid",
      record: { state: "vacant", epoch: ROOT_AUTHORITY_EPOCH },
    });
    expect(() => readFileSync(join(anchor, "owner.json"))).toThrow();
    grant.release();
  });
});

describe("root authority epoch and floor admission", () => {
  it("refuses a pre-fix (lower) writer epoch", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, { schemaVersion: 2, epoch: 1, state: "vacant" });
    expect(() => grantFor(socketPath, "3.4.0")).toThrow(
      expect.objectContaining({ code: "root_authority_epoch_unsupported" }),
    );
  });

  it("refuses a newer-than-supported writer epoch", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, { schemaVersion: 2, epoch: ROOT_AUTHORITY_EPOCH + 1, state: "vacant" });
    expect(() => grantFor(socketPath, "3.4.0")).toThrow(
      expect.objectContaining({ code: "root_authority_epoch_unsupported" }),
    );
  });

  it("refuses a candidate strictly below the proven serving floor", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, {
      schemaVersion: 2,
      epoch: ROOT_AUTHORITY_EPOCH,
      state: "served",
      floor: "3.5.0",
    });
    expect(() => grantFor(socketPath, "3.4.9")).toThrow(
      expect.objectContaining({ code: "root_authority_floor_regression" }),
    );
  });

  it("admits an equal semantic version for normal contention (SHA is evidence, not ordering)", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, {
      schemaVersion: 2,
      epoch: ROOT_AUTHORITY_EPOCH,
      state: "served",
      floor: "3.4.0",
    });
    const grant = grantFor(socketPath, "3.4.0");
    expect(grant.record.floor).toBe("3.4.0");
    grant.release();
  });

  it("admits a higher semantic version and keeps the floor until it re-proves serving", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, {
      schemaVersion: 2,
      epoch: ROOT_AUTHORITY_EPOCH,
      state: "served",
      floor: "3.4.0",
    });
    const grant = grantFor(socketPath, "3.5.0");
    expect(readRootAuthority(anchor)).toMatchObject({
      status: "valid",
      record: { floor: "3.4.0", state: "served" },
    });
    grant.release();
  });

  it("fails closed on a candidate version that cannot be ordered against a floor", () => {
    expect(() =>
      assertRootAuthorityAdmits(
        { schemaVersion: 2, epoch: ROOT_AUTHORITY_EPOCH, state: "served", floor: "3.4.0" },
        "not-a-semver",
      ),
    ).toThrow(expect.objectContaining({ code: "root_authority_floor_regression" }));
  });

  it("fails closed on a malformed or foreign-schema marker", () => {
    const malformed = tempSocket();
    writeMarker(malformed.anchor, { schemaVersion: 3, epoch: 9, state: "vacant" });
    expect(() => grantFor(malformed.socketPath, "3.4.0")).toThrow(
      expect.objectContaining({ code: "root_authority_unreadable" }),
    );
    const garbage = tempSocket();
    mkdirSync(garbage.anchor, { recursive: true, mode: 0o700 });
    writeFileSync(join(garbage.anchor, ROOT_AUTHORITY_MARKER_FILE), "not json\n", {
      mode: 0o600,
    });
    expect(() => grantFor(garbage.socketPath, "3.4.0")).toThrow(
      expect.objectContaining({ code: "root_authority_unreadable" }),
    );
  });
});

describe("root authority floor advancement and persistence", () => {
  it("advances the floor only through advanceFloor and keeps it monotonic", () => {
    const { socketPath, anchor } = tempSocket();
    const grant = grantFor(socketPath, "3.4.0");
    expect(grant.advanceFloor()).toEqual({
      schemaVersion: 2,
      epoch: ROOT_AUTHORITY_EPOCH,
      state: "served",
      floor: "3.4.0",
    });
    grant.release();

    // A later, higher candidate raises the floor after its own proof…
    const higher = grantFor(socketPath, "3.6.0");
    expect(higher.advanceFloor().floor).toBe("3.6.0");
    higher.release();

    // …and an equal-floor candidate can never lower it.
    const equal = grantFor(socketPath, "3.6.0");
    expect(equal.advanceFloor().floor).toBe("3.6.0");
    equal.release();
    expect(readRootAuthority(anchor)).toMatchObject({
      status: "valid",
      record: { floor: "3.6.0", state: "served" },
    });
  });

  it("keeps the barrier and its record across a clean release (never removed automatically)", () => {
    const { socketPath, anchor, marker } = tempSocket();
    const grant = grantFor(socketPath, "3.4.0");
    grant.advanceFloor();
    grant.release();
    expect(readRootAuthority(anchor)).toMatchObject({
      status: "valid",
      record: { state: "served", floor: "3.4.0" },
    });
    // The nested claim is gone, the barrier is not.
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({ status: "absent" });
    expect(readFileSync(marker, "utf8")).toContain('"state":"served"');
    // A pre-fix-shaped flat acquisition attempt still fails closed: the anchor
    // directory exists and carries no parseable owner record.
    expect(() => readFileSync(join(anchor, "owner.json"))).toThrow();
  });
});

describe("writer lease address redirect under a barrier", () => {
  it("resolves the flat anchor without a barrier and the nested slot with one", () => {
    const { socketPath, anchor } = tempSocket();
    expect(writerLeasePath(socketPath)).toBe(anchor);
    writeMarker(anchor, { schemaVersion: 2, epoch: ROOT_AUTHORITY_EPOCH, state: "vacant" });
    expect(writerLeasePath(socketPath)).toBe(join(anchor, "active.writer"));
  });

  it("routes plain lease acquisition and inspection through the nested slot", () => {
    const { socketPath, anchor } = tempSocket();
    writeMarker(anchor, { schemaVersion: 2, epoch: ROOT_AUTHORITY_EPOCH, state: "vacant" });
    const lease = acquireDaemonWriterLease(socketPath);
    expect(lease.path).toBe(join(anchor, "active.writer"));
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({
      status: "owned",
      owner: { pid: process.pid },
    });
    lease.release();
    expect(inspectDaemonWriterLease(socketPath)).toMatchObject({ status: "absent" });
    // Releasing the nested claim never releases the barrier.
    expect(readRootAuthority(anchor).status).toBe("valid");
  });
});
