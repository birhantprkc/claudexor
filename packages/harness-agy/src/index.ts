import type {
  AccessProfile,
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  HarnessUnavailableError,
  promptWithInstructions,
  runCapture,
  runCliHarness,
} from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseAgyEvent } from "./parse.js";
import { AGY_BIN, probeAgyCredentialProfile, resolveAgyProfileRoute } from "./profile.js";
import { AGY_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";
// The package publishes only what other packages consume. The profile probe,
// the route resolver and the stream parser are reached through the adapter
// this file returns, so re-exporting them would be a dead public surface.
export {
  AGY_BIN,
  agyProfileRunEnv,
  agyTokenFilePresent,
  canonicalAgyProfileHome,
} from "./profile.js";

/**
 * Access mapping, each leg LIVE-PROVEN on agy 1.1.13 (PLAN §1.2 F11, §1.2d):
 * plan mode answered read-only prompts and withheld a requested write;
 * accept-edits wrote into the workspace; --dangerously-skip-permissions wrote
 * and ran commands. Owner decision Л-7 admits full access explicitly.
 */
function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--mode", "plan"];
    case "workspace_write":
      return ["--mode", "accept-edits"];
    case "full":
    case "external_sandbox_full":
      return ["--dangerously-skip-permissions"];
    case "inherit_native":
      return [];
  }
}

async function detectVersion(): Promise<string | null> {
  try {
    const r = await runCapture(AGY_BIN(), ["--version"], { timeoutMs: 10_000 });
    return r.stdout.trim() || `${AGY_BIN()} (version unknown)`;
  } catch {
    return null;
  }
}

/**
 * Manifest model truth (INV-104): the vendor's own list, captured live from
 * `agy models` on the pinned version (evidence: PLAN §1.2 F9 and the sprint
 * evidence dir; the vendor emits TSV, not JSON, in 1.1.13). Slugs
 * carry the reasoning effort (`-high`/`-medium`/`-low`) exactly like Cursor's
 * inventory, so the effort ladder is deliberately empty and an effort hint is
 * disclosed as ignored rather than mapped (Л-21). No live `models()`:
 * `agy models --output-format json` is rejected by 1.1.13 (upstream #777) and
 * the unauthenticated plain listing fails — an empty live list would refuse
 * every explicit model (PLAN §2.6).
 */
const AGY_KNOWN_MODELS = [
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/**
 * The vendor's two quota GROUPS map onto disjoint halves of the same
 * inventory: "Gemini Models" and "Claude and GPT models" (PLAN §1.2 F8). The
 * split is DERIVED from the one model list so a slug the vendor adds cannot
 * land in neither half and silently escape window scoping (INV-138).
 */
export const AGY_GEMINI_MODELS = AGY_KNOWN_MODELS.filter((m) => m.startsWith("gemini-"));
export const AGY_THIRD_PARTY_MODELS = AGY_KNOWN_MODELS.filter((m) => !m.startsWith("gemini-"));

const AGY_ENABLED_INTENTS = [
  "explain",
  "plan",
  "spec",
  "implement",
  "repair",
  "create_from_scratch",
  "review",
  "verify",
  "synthesize",
  "audit",
] as const;

export function createAgyAdapter(): HarnessAdapter {
  return {
    id: "agy",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "agy not found on PATH (install Antigravity CLI or set CLAUDEXOR_AGY_BIN)",
        );
      }
      return HarnessManifestSchema.parse({
        id: "agy",
        display_name: "Antigravity",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "google",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No MCP flag path exists (config is file-only), so no browser
          // injector is wired — honest false (INV-066).
          browser_tool: false,
          // Built-in web tools with no enforceable off switch (cursor parity).
          web_policy: "uncontrolled",
          // D-16 default recommendation (В-10): the fenced-block tier costs
          // zero extra vendor turns; the schema-constrained tier is proven to
          // force a SECOND turn per run (PLAN §1.2e) and stays off until the
          // owner opts in.
          work_report_transport: "validated",
          // Effort rides the model slug (`-high`), not a flag (Л-21).
          effort_levels: [],
          known_models: [...AGY_KNOWN_MODELS],
          known_models_verified_against: AGY_VENDOR_CLI_VERSION,
        },
        capability_profile: {
          auth: {
            supported_sources: ["native_session"],
            preferred_source: "native_session",
            credential_transports: [
              // The profile HOME relocates the vendor's whole config root and
              // its file-based OAuth token (Л-15/Л-16): config_file, HOME.
              { source: "native_session", kind: "config_file", relocatable_by: ["HOME"] },
            ],
          },
          // readonly = vendor plan mode: write tools are withheld
          // (permission-denied), reads and answers flow (live-proven F11).
          access_control: { readonly_mechanism: "permission_deny" },
          isolation: { supported_containment: ["env_or_file_injection"] },
          // No proven attachment path yet — honest empty set (INV-064/065).
          attachment_inputs: [],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: [
          "readonly",
          "workspace_write",
          "full",
          "external_sandbox_full",
          "inherit_native",
        ],
      });
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      const installedSemver =
        version === null ? null : (/\d+\.\d+\.\d+/.exec(version)?.[0] ?? null);
      const versionDrift =
        version !== null && installedSemver !== AGY_VENDOR_CLI_VERSION
          ? `installed agy "${version}" differs from the verified ${AGY_VENDOR_CLI_VERSION}; the file-token profile mechanism is re-proven per version (R-2')`
          : null;
      const requestedSource = spec.authSource;
      if (requestedSource !== undefined && requestedSource !== "native_session") {
        return ConformanceReportSchema.parse({
          harness_id: "agy",
          status: "unavailable",
          checks: [
            version === null
              ? { id: "installed", status: "fail", detail: "agy not found" }
              : { id: "installed", status: "pass", detail: redactSecrets(version) },
            {
              id: "auth_source",
              status: "fail",
              detail: `agy does not support ${requestedSource}`,
            },
          ],
          enabled_intents: [],
          disabled_intents: AGY_ENABLED_INTENTS,
          reasons: [`agy does not support auth source ${requestedSource}`],
          auth_sources: [
            {
              source: requestedSource,
              availability: "unavailable",
              verification: "not_run",
              detail: `agy does not support ${requestedSource}`,
            },
          ],
        });
      }
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "agy",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "agy not found" }],
          enabled_intents: [],
          disabled_intents: AGY_ENABLED_INTENTS,
          reasons: ["agy not found (install Antigravity CLI or set CLAUDEXOR_AGY_BIN)"],
          auth_sources: [
            {
              source: "native_session",
              availability: "unknown",
              verification: "not_run",
              detail: "agy binary not installed",
            },
          ],
        });
      }
      // Owner decision Л-4: agy has NO engine-default credential store — every
      // account is a named profile. The harness-level doctor therefore reports
      // the default subject honestly unavailable with the remedy; PINNED
      // routing is admitted by the per-profile probe (INV-135 round-15 #1),
      // exactly like a logged-out cursor default with valid named profiles.
      return ConformanceReportSchema.parse({
        harness_id: "agy",
        status: "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: redactSecrets(version) },
          {
            id: "default_credential",
            status: "fail",
            detail: "agy has no engine-default credential by design; accounts are named profiles",
          },
          ...(versionDrift
            ? [{ id: "version_pin", status: "fail" as const, detail: versionDrift }]
            : [{ id: "version_pin", status: "pass" as const, detail: AGY_VENDOR_CLI_VERSION }]),
        ],
        enabled_intents: [],
        disabled_intents: AGY_ENABLED_INTENTS,
        reasons: [
          "agy routes only through named accounts: add one (`claudexor profiles add agy <id>` + `claudexor profiles login agy <id>`) and pin it (--profile)",
          ...(versionDrift ? [versionDrift] : []),
        ],
        auth_sources: [
          {
            source: "native_session",
            availability: "unavailable",
            verification: "not_run",
            detail: "no default store by design (accounts are named profiles)",
          },
        ],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runAgy(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runAgy(spec);
    },

    // INV-135: pinned routing is admitted by THIS probe (there is no default
    // store for the harness doctor to credit).
    async probeCredentialProfile(profile) {
      return probeAgyCredentialProfile(profile);
    },
  };
}

async function* runAgy(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  const profile = spec.credential_profile;
  // Л-4: no engine-default credential — an unpinned agy run has nothing to
  // route. Typed stream refusal (error then completed), the one refusal
  // mechanism every adapter's profile gate uses.
  if (!profile) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error:
        "agy has no engine-default credential; pin a named account (--profile, or `claudexor profiles add agy <id>`)",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const route = resolveAgyProfileRoute(profile, spec.env);
  if ("refusal" in route) {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: route.refusal };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }

  const args = ["-p", promptWithInstructions(spec), "--output-format", "stream-json"];
  // Л-18: without --add-dir agy resolves relative paths against its own app
  // data dir instead of the workspace (live-proven §1.2d).
  args.push("--add-dir", spec.cwd);
  args.push(...accessArgs(spec.access));
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // INV-137: the vendor conversation id is the resumable native session.
  if (spec.resume_session_id) args.push("--conversation", spec.resume_session_id);

  yield* runCliHarness({
    bin: AGY_BIN(),
    args,
    spec,
    env: route.env,
    label: "agy",
    redact: redactSecrets,
    parseEvent: (obj, sessionId) => {
      const out = parseAgyEvent(obj, sessionId);
      if (out) {
        for (const ev of out) {
          ev.credential_route = "vendor_native";
          ev.credential_source = "native_session";
          ev.credential_profile_id = profile.profile_id;
        }
      }
      return out;
    },
  });
}
