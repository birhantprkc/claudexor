import { describe, expect, it } from "vitest";
import { RoutingPreflightError } from "@claudexor/budget";
import { harnessFailureNextActions } from "./harnessFailure.js";
import { routingFailureClassification } from "./orchestrator.js";

/**
 * A-1/D-9/#22: a routing preflight refusal (quality routing with no comparable
 * user-declared tier for the intent) is a CONFIGURATION error, not a
 * harness-availability problem. Every strategy's routing catch runs the throw
 * through this one classifier, so it must map RoutingPreflightError → config_error
 * (with config remediation) and every other routing throw → harness_unavailable.
 */
describe("routingFailureClassification", () => {
  it("classifies a RoutingPreflightError as config_error with config remediation", () => {
    const err = new RoutingPreflightError(
      "quality routing requires a comparable user-declared tier for intent 'implement'",
    );
    expect(err.code).toBe("routing_preflight_refused");
    const result = routingFailureClassification(err);
    expect(result.category).toBe("config_error");
    // Config remediation, never auth/harness-availability guidance.
    expect(result.nextActions).toEqual(harnessFailureNextActions("config_error"));
    expect(result.nextActions?.join(" ")).not.toMatch(/re-?authenticate/i);
  });

  it("detects the refusal by typed code (robust across duplicate package copies)", () => {
    // A structurally-equal error from another @claudexor/budget copy carries the
    // same typed `code` but fails instanceof; the classifier must still catch it.
    const cloned = Object.assign(new Error("preflight refused"), {
      code: "routing_preflight_refused",
    });
    expect(routingFailureClassification(cloned).category).toBe("config_error");
  });

  it("classifies any other routing throw as harness_unavailable with no config remediation", () => {
    const result = routingFailureClassification(
      new Error("no harness remains eligible for 'implement' after budget and quota routing"),
    );
    expect(result.category).toBe("harness_unavailable");
    expect(result.nextActions).toBeUndefined();
  });

  it("is null-safe for a non-object throw", () => {
    expect(routingFailureClassification("boom").category).toBe("harness_unavailable");
    expect(routingFailureClassification(undefined).category).toBe("harness_unavailable");
  });

  /**
   * Quota admission moved INTO routing (the account that will actually spawn is
   * the one whose windows are checked), so a spent subscription window is now
   * thrown here rather than inside a candidate attempt. The per-slot catch that
   * records `CandidateRun.declaredFailure` never sees it, which makes this
   * classifier the last place that can carry the typed refusal. If it drops the
   * code, `final/failure.yaml` says `code: null` and a scheduler is back to
   * parsing prose for the reopen time.
   */
  it("carries a typed refusal's code and reset time through the routing terminal", () => {
    const resetsAt = "2026-08-02T18:00:00.000Z";
    const err = Object.assign(new Error("credential profile is over its headroom threshold"), {
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt,
    });
    const result = routingFailureClassification(err);
    expect(result.category).toBe("harness_unavailable");
    expect(result.code).toBe("subscription_window_exhausted");
    expect(result.resetsAt).toBe(resetsAt);
  });

  it("never lets an unrecognized code reach the terminal as a sub-code", () => {
    // `routing_preflight_refused` is a classification marker, not a RunFailureCode;
    // an arbitrary string must not be smuggled into failure.yaml's `code` either.
    expect(routingFailureClassification(new RoutingPreflightError("refused")).code).toBeNull();
    expect(
      routingFailureClassification(Object.assign(new Error("x"), { code: "not_a_real_code" })).code,
    ).toBeNull();
  });
});
