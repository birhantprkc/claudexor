import { describe, expect, it } from "vitest";
import { validateModel } from "@claudexor/core";
import { knownModelIdsForRoute } from "@claudexor/schema";
import {
  CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
  claudeQuotaModelAliases,
} from "./capability-profile.js";
import { createClaudeAdapter } from "./index.js";

/**
 * Manifest model-truth pinning (INV-104): `known_models` is the strict truth
 * source — an explicit model outside it is refused up front, never forwarded
 * to die as an opaque native error. These tests pin the CURRENT catalog
 * entries end to end: the manifest advertises the id, the stamp names the
 * exact installed CLI the list was verified against, and the truth owner
 * (`validateModel`) accepts the id round-trip. A model added to the vendor
 * catalog but missing here is exactly the PR #54 defect shape: the newest
 * Opus was unpinnable while the bare `opus` alias silently floated.
 */
const stubAdapter = () =>
  createClaudeAdapter({
    detectVersion: async () => "2.1.165 (Claude Code)",
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({
      levels: ["low", "medium", "high", "xhigh", "max"],
      live: true,
    }),
  });

describe("the claude manifest model truth source", () => {
  it("advertises the current Opus generation — claude-opus-5 AND the still-active claude-opus-4-5", async () => {
    const manifest = await stubAdapter().discover();
    const known = manifest.capabilities.known_models;
    expect(known).toContain("claude-opus-5");
    expect(known).toContain("claude-opus-4-5");
  });

  it("stamps known_models_verified_against with the declared stamp constant", async () => {
    // The strict freshness gate compares this stamp against the INSTALLED
    // CLI; this test pins the wiring — the manifest exposes exactly the
    // declared constant, so re-verification is a one-place edit.
    const manifest = await stubAdapter().discover();
    expect(manifest.capabilities.known_models_verified_against).toBe(
      CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
    );
  });

  it("round-trips through the truth owner: validateModel accepts a manifest id and refuses a foreign one", async () => {
    // The EXACT production path (modelGovernance.ts): the schema's one owner
    // flattens the route-scoped list, then `validateModel` judges against it.
    const manifest = await stubAdapter().discover();
    const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
    expect(validateModel("claude-opus-5", known, "manifest").status).toBe("ok");
    expect(validateModel("claude-opus-4-5", known, "manifest").status).toBe("ok");
    // STRICT semantics: outside the list → rejected, naming the truth source.
    const rejected = validateModel("claude-opus-9-9", known, "manifest");
    expect(rejected.status).toBe("rejected");
    expect(rejected.message).toContain("manifest known-model list");
  });

  it("projects vendor quota family names onto the manifest aliases", () => {
    expect(claudeQuotaModelAliases(" Opus ")).toEqual([
      "opus",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "best",
    ]);
    expect(claudeQuotaModelAliases("Sonnet")).toEqual([
      "sonnet",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "best",
    ]);
    expect(claudeQuotaModelAliases("Future")).toEqual(["future", "best"]);
    expect(claudeQuotaModelAliases("   ")).toEqual([]);
  });
});
