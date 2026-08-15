// Executable compatibility fixture derived from v3.3.7's
// packages/daemon/src/writer-lease.ts. Keep acquisition markers byte-parallel;
// provenance.json binds this compact claimant to the exact upstream source.
const { randomUUID } = require("node:crypto");
const { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");

function writerBusy(path) {
  return Object.assign(new Error(`another claudexor daemon owns ${path}`), {
    code: "daemon_writer_busy",
    status: 409,
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLeaseOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string"
    ) {
      return null;
    }
    return { pid: Number(value.pid), token: value.token };
  } catch {
    return null;
  }
}

function acquireDaemonWriterLease(socketPath) {
  const path = `${socketPath}.writer`;
  const token = randomUUID();
  const ownerPath = `${path}/owner.json`;
  const owner = { pid: process.pid, token };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLeaseOwner(ownerPath);
      if (!existing || processIsAlive(existing.pid)) throw writerBusy(path);
      const stale = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(path, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
      if (attempt === 1) throw new Error(`could not replace stale daemon writer lease ${path}`);
    }
  }
  return { path, owner };
}

try {
  const socketPath = process.env.CLAUDEXOR_DAEMON_SOCK;
  if (!socketPath) throw new Error("CLAUDEXOR_DAEMON_SOCK is required");
  const lease = acquireDaemonWriterLease(socketPath);
  process.stdout.write(
    `${JSON.stringify({ ok: true, stage: "writer_claim", path: lease.path })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: typeof error.code === "string" ? error.code : "legacy_claim_failed",
      stage: "writer_claim",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
