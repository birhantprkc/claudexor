import { describe, expect, it } from "vitest";
import type { CredentialUnusableObservation, HarnessEvent } from "@claudexor/schema";
import { CredentialUnusableLedger } from "./credential-unusable-ledger.js";

const T0 = Date.parse("2026-08-18T10:00:00.000Z");

function ledgerAt(): { ledger: CredentialUnusableLedger; clock: { now: number } } {
  const clock = { now: T0 };
  return { ledger: new CredentialUnusableLedger(() => new Date(clock.now)), clock };
}

function obs(over: Partial<CredentialUnusableObservation>): CredentialUnusableObservation {
  return {
    harness_id: "claude",
    profile_id: "work",
    model: null,
    code: "auth_revoked",
    source: "vendor_poller",
    detail: null,
    observed_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 60 * 60_000).toISOString(),
    ...over,
  };
}

function usage(over: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    type: "usage",
    session_id: "se-1",
    ts: new Date(T0).toISOString(),
    usage: { input_tokens: 10, output_tokens: 5 },
    credential_profile_id: "work",
    ...over,
  } as HarnessEvent;
}

describe("CredentialUnusableLedger (A7 bounded typed evidence)", () => {
  it("records a typed observation and serves it while live", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.live()[0]).toMatchObject({ code: "auth_revoked", profile_id: "work" });
  });

  it("rejects a malformed observation loudly (schema-parsed, never silently stored)", () => {
    const { ledger } = ledgerAt();
    expect(() =>
      ledger.record({ ...obs({}), code: "made_up" } as unknown as CredentialUnusableObservation),
    ).toThrow();
  });

  it("an EXPIRED observation is never served (clearing contract: self-expiry)", () => {
    const { ledger, clock } = ledgerAt();
    ledger.record(obs({}));
    clock.now = T0 + 2 * 60 * 60_000;
    expect(ledger.live()).toHaveLength(0);
  });

  it("clamps every write to the 24h TTL bound", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ expires_at: new Date(T0 + 7 * 24 * 60 * 60_000).toISOString() }));
    const row = ledger.live()[0]!;
    expect(Date.parse(row.expires_at) - T0).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("a served model response for the SAME subject clears its credential-wide rows (clearing contract: success)", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.record(obs({ profile_id: "other" }));
    ledger.observeEvent("claude", usage());
    expect(ledger.live().map((o) => o.profile_id)).toEqual(["other"]);
  });

  it("a ZERO-token usage event proves nothing and clears nothing", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.observeEvent("claude", usage({ usage: { input_tokens: 0, output_tokens: 0 } }));
    expect(ledger.live()).toHaveLength(1);
  });

  it("a MODEL-SCOPED row clears only on an exactly-matching observed model", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ code: "capability_refused", model: "opus" }));
    ledger.observeEvent("claude", usage({ observed_model: "sonnet" }));
    expect(ledger.live()).toHaveLength(1);
    ledger.observeEvent("claude", usage({ observed_model: "opus" }));
    expect(ledger.live()).toHaveLength(0);
  });

  it("success on ANOTHER subject never clears this one", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.observeEvent("claude", usage({ credential_profile_id: "other" }));
    ledger.observeEvent("codex", usage());
    expect(ledger.live()).toHaveLength(1);
  });

  it("a credential-generation change voids every verdict (clearing contract: re-login)", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({}));
    ledger.record(obs({ profile_id: "other" }));
    ledger.noteCredentialChange();
    expect(ledger.live()).toHaveLength(0);
  });

  it("stays bounded: the earliest-expiring row is evicted, never the newest evidence refused", () => {
    const { ledger } = ledgerAt();
    for (let i = 0; i < 64; i += 1) {
      ledger.record(
        obs({
          profile_id: `p${i}`,
          expires_at: new Date(T0 + (i + 1) * 60_000).toISOString(),
        }),
      );
    }
    ledger.record(
      obs({ profile_id: "newest", expires_at: new Date(T0 + 90 * 60_000).toISOString() }),
    );
    const ids = ledger.live().map((o) => o.profile_id);
    expect(ids).toHaveLength(64);
    expect(ids).toContain("newest");
    expect(ids).not.toContain("p0");
  });

  it("newest-wins per (subject, model): re-recording replaces, never duplicates", () => {
    const { ledger } = ledgerAt();
    ledger.record(obs({ code: "auth_revoked" }));
    ledger.record(obs({ code: "verification_failed", source: "local_probe" }));
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.live()[0]?.code).toBe("verification_failed");
  });
});
