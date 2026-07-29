import type {
  AccessProfile,
  AuthPreference,
  EffortHint,
  ExternalContextPolicy,
  ModeKind,
  PaidBudget,
  ProtectedPathApproval,
  RoutingGoal,
  TaskContract,
  TestCommandInvocation,
} from "@claudexor/schema";
import {
  FrozenTaskContractArtifact as TaskContractSchema,
  SCHEMA_VERSION,
  TRUST_FULL_ACCESS_CODE,
} from "@claudexor/schema";
import { loadConfig, trustConfigPath } from "@claudexor/config";
import { nowIso, redactSecrets } from "@claudexor/util";
import { resolveContractGates } from "./contract-gates.js";

interface TaskContractBuildInput {
  repoRoot: string;
  prompt: string;
  instructions?: string;
  baseRef?: string;
  delegate?: boolean;
  parentRunId?: string | null;
  delegatedFromRunId?: string | null;
  tests?: TestCommandInvocation[];
  protectedPathApprovals?: ProtectedPathApproval[];
  denyPaths?: string[];
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
  access?: AccessProfile;
  web?: ExternalContextPolicy;
  externalContextPolicy?: ExternalContextPolicy;
  outputSchema?: Record<string, unknown> | null;
  authPreference?: AuthPreference;
  credentialProfileId?: string | null;
  maxTurns?: number | null;
  models?: Record<string, string>;
  efforts?: Record<string, EffortHint>;
}

export interface TaskContractDefaults {
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
}

/**
 * Build and validate the immutable task contract from one resolved run input.
 * This is the single owner for trust, gate, access, and frozen route facts.
 */
export function buildTaskContract(
  input: TaskContractBuildInput,
  taskId: string,
  mode: ModeKind,
  defaults: TaskContractDefaults,
): TaskContract {
  const resolvedCfg = loadConfig(input.repoRoot);
  const cfg = resolvedCfg.project;
  const readOnlyMode = mode === "ask" || mode === "plan";
  const requestedAccess =
    input.access ?? (readOnlyMode ? "readonly" : resolvedCfg.trust.access_default);
  // Effective access is COMPUTED by the engine, never echoed from a client:
  // read-only modes clamp to readonly regardless of the request.
  const effectiveAccess: AccessProfile = readOnlyMode ? "readonly" : requestedAccess;
  // TrustConfig is USER-LEVEL only (versioned repo config must never
  // self-grant sensitive powers): unsandboxed full access requires an
  // explicit allow in ~/.claudexor trust settings — loud error, no downgrade.
  // The gate applies to the EFFECTIVE profile: a read-only run clamped to
  // readonly never runs unsandboxed and needs no trust allow.
  if (effectiveAccess === "full" && !resolvedCfg.trust.allow_full_access) {
    // Typed refusal: the `code` rides the daemon job record onto the thread
    // turn (TurnEnqueueError.code), so surfaces key remedies on the CODE —
    // never on substring-matching this human message.
    throw Object.assign(
      new Error(
        `access profile 'full' requires allow_full_access: true in the user-level trust file for this repo ` +
          `(${trustConfigPath(input.repoRoot)}); enable it with \`claudexor trust --allow-full-access\` — refusing to run unsandboxed`,
      ),
      // Refusal semantics are born at the throw (W24): the one-time grant is
      // a 403, and the daemon persists this status onto the job record.
      { code: TRUST_FULL_ACCESS_CODE, status: 403 },
    );
  }
  const externalContextPolicy = input.web ?? input.externalContextPolicy ?? "auto";
  // Deterministic gate commands come from explicit run input, then versioned
  // project config. Without these, gateSpecs is empty and convergence is
  // review-only; with them, convergence is test-driven.
  const resolvedGates = resolveContractGates({
    repoRoot: input.repoRoot,
    effectiveAccess,
    config: cfg,
    trustGrants: resolvedCfg.trust.test_command_grants,
    operatorCommands: input.tests ?? [],
    projectCommands: cfg.tests?.commands ?? [],
  });
  const commands = resolvedGates.commands;
  const protectedPaths = [...new Set(cfg.constraints.protected_paths)];
  const autoProtectedPaths = resolvedGates.autoProtectedPaths;
  const protectedPathApprovals = [
    ...new Map(
      [...(input.protectedPathApprovals ?? [])].map((approval) => [approval.path, approval]),
    ).values(),
  ];
  return TaskContractSchema.parse({
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    created_at: nowIso(),
    repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD", dirty_policy: "snapshot" },
    mode: { kind: mode },
    delegation_requested: input.delegate === true,
    run_lineage: {
      parent_run_id: input.parentRunId ?? null,
      delegated_from_run_id: input.delegatedFromRunId ?? null,
    },
    user_intent: { raw: redactSecrets(input.prompt) },
    // Redacted for symmetry with user_intent.raw — a no-op on fenced input
    // (the inline-secret fence already blocked any secret-like value at every
    // ingress incl. this engine boundary), so task-producing lanes read back
    // the real instructions via harnessSpecKnobs().
    instructions: input.instructions === undefined ? undefined : redactSecrets(input.instructions),
    // Already normalized/strictified at the engine boundary (run() refuses
    // unsupported shapes before any run dir exists).
    output_schema: input.outputSchema ?? null,
    auth_preference: input.authPreference ?? "auto",
    credential_profile_id: input.credentialProfileId ?? null,
    max_turns: input.maxTurns ?? null,
    constraints: {
      protected_paths: protectedPaths,
      deny_paths: [...new Set(input.denyPaths ?? [])],
      auto_protected_paths: autoProtectedPaths,
      protected_path_approvals: protectedPathApprovals,
    },
    tests: { commands },
    access: {
      requested_profile: requestedAccess,
      effective_profile: effectiveAccess,
    },
    external_context: {
      policy: externalContextPolicy,
      web_required: externalContextPolicy === "cached" || externalContextPolicy === "live",
      // Per-route upgrades (e.g. claude cached->live) are disclosed in events
      // and telemetry.yaml; the immutable contract records the requested policy.
      effective_mode: externalContextPolicy,
    },
    // Harness-native tool names are adapter knowledge; the neutral contract
    // carries only the policy plus user-configured allow/deny lists (wired
    // from per-harness settings).
    tool_permission_policy: {
      web: externalContextPolicy,
      allow: [],
      deny: [],
    },
    budget: {
      routing_goal:
        input.routingGoal ?? defaults.routingGoal ?? cfg?.budget?.routing_goal ?? "auto",
      paid_budget:
        input.paidBudget ?? defaults.paidBudget ?? resolvedCfg.global.budget.paid_budget_per_run,
    },
    // The resolved harness-scoped model map (scalar already expanded to the
    // primary by resolveRunInput). The contract is what route spec building
    // reads — there is no run-global model (INV-103).
    routing_models: input.models ?? {},
    // QA-035: resolveRunInputDefaults has already expanded explicit, scalar,
    // and Settings-derived effort into a frozen per-lane map. Persist that map
    // verbatim so TaskContract construction cannot re-read a later Settings
    // state or leave pure Auto routing as a drift seam.
    routing_efforts: input.efforts ?? {},
  });
}
