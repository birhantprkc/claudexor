import { afterEach, describe, expect, it } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  ENGINE_STOP_REMEDY,
  consumeHandshakeIdentity,
  observedEngineSkew,
  recordEngineSkew,
  stampEngineSkew,
} from "./engine-skew.js";

afterEach(() => recordEngineSkew(null));

function canonical(version: string, sha = "unknown"): unknown {
  return {
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version, sha, entry: "/e" },
  };
}

describe("engine-skew record (#93)", () => {
  it("records, overwrites, and clears; reads return copies", () => {
    recordEngineSkew({ daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION });
    const first = observedEngineSkew();
    expect(first).toEqual({ daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION });
    // A copy: mutating the read never corrupts the record.
    (first as { daemonVersion: string }).daemonVersion = "tampered";
    expect(observedEngineSkew()?.daemonVersion).toBe("3.2.1");
    recordEngineSkew({ daemonVersion: "3.2.2", cliVersion: CLAUDEXOR_VERSION });
    expect(observedEngineSkew()?.daemonVersion).toBe("3.2.2");
    recordEngineSkew(null);
    expect(observedEngineSkew()).toBeNull();
  });
});

describe("consumeHandshakeIdentity", () => {
  it("records a validated same-major skew with the daemon sha and returns the advisory", () => {
    const sha = "f".repeat(40);
    const identity = consumeHandshakeIdentity(canonical("9.9.9", sha));
    expect(identity.engine).toEqual({ engineVersion: "9.9.9", engineBuildSha: sha });
    expect(identity.skewAdvisory).toContain("daemon is engine 9.9.9");
    expect(identity.skewAdvisory).toContain(ENGINE_STOP_REMEDY);
    expect(observedEngineSkew()).toEqual({
      daemonVersion: "9.9.9",
      daemonSha: sha,
      cliVersion: CLAUDEXOR_VERSION,
    });
  });

  it("clears a stale record when the daemon matches this CLI", () => {
    recordEngineSkew({ daemonVersion: "9.9.9", cliVersion: CLAUDEXOR_VERSION });
    const identity = consumeHandshakeIdentity(canonical(CLAUDEXOR_VERSION));
    expect(identity.engine).toEqual({
      engineVersion: CLAUDEXOR_VERSION,
      engineBuildSha: "unknown",
    });
    expect(identity.skewAdvisory).toBeNull();
    expect(observedEngineSkew()).toBeNull();
  });

  it("treats a non-canonical body as no identity and clears the record", () => {
    recordEngineSkew({ daemonVersion: "9.9.9", cliVersion: CLAUDEXOR_VERSION });
    const identity = consumeHandshakeIdentity({
      ok: true,
      engine: { version: "9.9.9", sha: "x", entry: "/e" },
    });
    expect(identity).toEqual({
      engine: { engineVersion: null, engineBuildSha: null },
      skewAdvisory: null,
    });
    expect(observedEngineSkew()).toBeNull();
  });

  it("echo hygiene: an unvalidated version never reaches the advisory or the record", () => {
    const identity = consumeHandshakeIdentity(canonical("9.9.9 $(rm -rf /)", "x".repeat(40)));
    expect(identity.engine.engineVersion).toBeNull();
    expect(identity.skewAdvisory).toBeNull();
    expect(observedEngineSkew()).toBeNull();
  });

  it("omits a malformed sha from the identity and the skew record", () => {
    const identity = consumeHandshakeIdentity(canonical("9.9.9", "not-a-sha"));
    expect(identity.engine).toEqual({ engineVersion: "9.9.9", engineBuildSha: null });
    expect(observedEngineSkew()).toEqual({
      daemonVersion: "9.9.9",
      cliVersion: CLAUDEXOR_VERSION,
    });
  });
});

describe("stampEngineSkew (the controlProblemError choke point)", () => {
  it("returns the fields object UNCHANGED with no skew and nothing to append", () => {
    const fields = {
      code: "config_invalid",
      requiredActions: ["inspect and fix the file"],
      context: { path: "/tmp/x" },
    };
    expect(stampEngineSkew(fields)).toBe(fields);
  });

  it("attaches engineSkew context and the stop remedy exactly once when skewed", () => {
    recordEngineSkew({ daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION });
    const stamped = stampEngineSkew({
      code: "config_invalid",
      requiredActions: ["inspect and fix the file"],
      context: { path: "/tmp/x" },
    });
    expect(stamped.requiredActions).toEqual(["inspect and fix the file", ENGINE_STOP_REMEDY]);
    expect(stamped.context).toEqual({
      path: "/tmp/x",
      engineSkew: { daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION },
    });
    // The problem's own fields ride through untouched.
    expect(stamped.code).toBe("config_invalid");
  });

  it("dedupes a remedy the problem already names and appends explicit actions", () => {
    recordEngineSkew({ daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION });
    const stamped = stampEngineSkew({ requiredActions: [ENGINE_STOP_REMEDY] }, [
      ENGINE_STOP_REMEDY,
    ]);
    expect(stamped.requiredActions).toEqual([ENGINE_STOP_REMEDY]);
    const appended = stampEngineSkew({}, ["use control protocol major 4"]);
    expect(appended.requiredActions).toEqual(["use control protocol major 4", ENGINE_STOP_REMEDY]);
  });

  it("appends explicit actions without inventing skew context when unskewed", () => {
    const stamped = stampEngineSkew({ code: "incompatible_protocol_major" }, [ENGINE_STOP_REMEDY]);
    expect(stamped.requiredActions).toEqual([ENGINE_STOP_REMEDY]);
    expect(stamped.context).toBeUndefined();
  });
});
