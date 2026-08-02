import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalFuturePath(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`battery path has no existing ancestor: ${absolute}`);
    suffix.unshift(ancestor.slice(parent.length + 1));
    ancestor = parent;
  }
  const stat = lstatSync(ancestor);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(ancestor) !== ancestor) {
    throw new Error(`battery path ancestor is not canonical: ${ancestor}`);
  }
  const canonical = join(ancestor, ...suffix);
  if (canonical !== absolute) throw new Error(`battery path is not canonical: ${absolute}`);
  return canonical;
}

export function assertNoPreexistingDaemon({ statusCode, socketIsAlive, leaseIsAlive }) {
  if (statusCode === 0) throw new Error("refusing a pre-existing Claudexor daemon");
  if (socketIsAlive || leaseIsAlive) {
    throw new Error("daemon preflight found a live socket or writer-lease owner");
  }
}

export function sameDaemonLease(expected, current) {
  return Boolean(
    expected && current && expected.pid === current.pid && expected.token === current.token,
  );
}

/** Preserve the serving identity observed from a fresh daemon even when it is
 * not the requested candidate, so cleanup can target that exact process. */
export function runtimeReplacementIdentityFromHandshake(handshake) {
  const engine = handshake?.engine;
  if (
    !engine ||
    typeof engine !== "object" ||
    typeof engine.version !== "string" ||
    engine.version.length === 0 ||
    typeof engine.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(engine.sha)
  ) {
    return null;
  }
  return { version: engine.version, buildSha: engine.sha };
}

export function evaluateRequiredNativeRoutes(requiredHarnesses, observed) {
  const missing = requiredHarnesses.filter(
    (harnessId) => !observed.some((route) => route.harnessId === harnessId),
  );
  const nonNative = observed.filter(
    (route) => route.authMode !== "local_session" || route.authSource !== "native_session",
  );
  return { valid: missing.length === 0 && nonNative.length === 0, missing, nonNative };
}

/** Normalize every durable route interval/switch without trusting first-route telemetry. */
export function durableAttemptRouteEvidence(events) {
  const observed = [];
  let sawStarted = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "started") {
      sawStarted = true;
      observed.push({
        kind: "started",
        authMode:
          event.credential_route === "vendor_native"
            ? "local_session"
            : event.credential_route === "managed_api_key"
              ? "api_key"
              : null,
        authSource: typeof event.credential_source === "string" ? event.credential_source : null,
      });
      continue;
    }
    if (event.credential_route === "managed_api_key") {
      observed.push({
        kind: "api_route_event",
        authMode: "api_key",
        authSource: typeof event.credential_source === "string" ? event.credential_source : null,
      });
    }
    if (event.type === "message" && event.payload?.auth_switched === true) {
      const toAuthMode = event.payload.to_auth_mode;
      const switchedToNative = toAuthMode === "local_session" || toAuthMode === "subscription";
      observed.push({
        kind: "auth_switched",
        authMode: toAuthMode === "api_key" ? "api_key" : switchedToNative ? "local_session" : null,
        authSource: switchedToNative ? "native_session" : null,
      });
    }
  }
  return { sawStarted, observed };
}

/** Resolve the battery's storage mode before any directory or daemon mutation. */
export function resolveRealHarnessBatteryLayout({
  home,
  sourceRoot,
  defaultBatteryRoot,
  batteryDir,
  requestedConfigDir,
  ambientConfigDir,
}) {
  const canonicalHome = realpathSync.native(resolve(home));
  const canonicalSource = realpathSync.native(resolve(sourceRoot));
  const requested = requestedConfigDir?.trim();
  if (!requested) {
    const batteryRoot = canonicalFuturePath(batteryDir?.trim() || defaultBatteryRoot);
    return {
      mode: "scratch",
      batteryRoot,
      configDir: join(batteryRoot, "config"),
      exportConfigDir: true,
    };
  }

  if (ambientConfigDir?.trim()) {
    throw new Error(
      "CLAUDEXOR_BATTERY_CONFIG_DIR cannot be combined with CLAUDEXOR_CONFIG_DIR; unset the latter",
    );
  }
  if (!isAbsolute(requested)) {
    throw new Error("CLAUDEXOR_BATTERY_CONFIG_DIR must be an absolute path");
  }
  const expectedConfigDir = join(canonicalHome, ".claudexor", "v3");
  const requestedAbsolute = resolve(requested);
  const requestedStat = lstatSync(requestedAbsolute);
  if (
    requestedAbsolute !== expectedConfigDir ||
    requestedStat.isSymbolicLink() ||
    !requestedStat.isDirectory() ||
    realpathSync.native(requestedAbsolute) !== expectedConfigDir
  ) {
    throw new Error(
      `CLAUDEXOR_BATTERY_CONFIG_DIR must be the canonical default config directory ${expectedConfigDir}`,
    );
  }
  if (!batteryDir?.trim() || !isAbsolute(batteryDir.trim())) {
    throw new Error(
      "CLAUDEXOR_BATTERY_DIR must be an explicit absolute path in existing-default mode",
    );
  }
  const batteryRoot = canonicalFuturePath(batteryDir.trim());
  const ownedRoot = join(canonicalHome, ".claudexor");
  if (isWithin(ownedRoot, batteryRoot)) {
    throw new Error("CLAUDEXOR_BATTERY_DIR must be outside the Claudexor runtime tree");
  }
  if (isWithin(canonicalSource, batteryRoot)) {
    throw new Error("CLAUDEXOR_BATTERY_DIR must be outside the Claudexor source checkout");
  }
  return {
    mode: "existing_default",
    batteryRoot,
    configDir: expectedConfigDir,
    // Omitting the override is semantically important: an explicit override
    // would narrow claudexorOwnedRoot() and invalidate existing profile paths.
    exportConfigDir: false,
  };
}

export function snapshotRegularFile(path) {
  if (!existsSync(path)) return { exists: false, bytes: null, digest: null, mode: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`refusing unsafe battery state file: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    exists: true,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    mode: stat.mode & 0o777,
  };
}

export function describeFileSnapshot(snapshot) {
  return {
    exists: snapshot.exists,
    digest: snapshot.digest,
    mode: snapshot.mode,
  };
}

export function assertRegularFileUnchanged(path, before) {
  const after = snapshotRegularFile(path);
  const same =
    before.exists === after.exists &&
    before.mode === after.mode &&
    (before.bytes === null ? after.bytes === null : before.bytes.equals(after.bytes));
  if (!same) throw new Error(`battery changed protected state file: ${path}`);
  return after;
}
