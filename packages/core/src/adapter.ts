import type {
  AccountIdentity,
  AuthPreference,
  AuthSourceKind,
  ConformanceReport,
  CredentialProfile,
  CredentialProfileStatus,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessModel,
  HarnessRunSpec,
  InteractionAnswerSet,
  InteractionRequest,
  ProcessingPreference,
  ProcessingReceipt,
  ProcessingCostBasis,
} from "@claudexor/schema";

/** Accounts-only doctor receipt. Identity never widens generic HarnessStatus. */
export interface HarnessAccountDoctorReceipt {
  report: ConformanceReport;
  identity: AccountIdentity | null;
}

/** Accounts-only profile receipt: one probe owns readiness and identity. */
export interface CredentialAccountProbeReceipt {
  status: CredentialProfileStatus;
  identity: AccountIdentity | null;
}

export interface DoctorSpec {
  cwd: string;
  /** Optional scoped env for probes that must mirror a concrete run route. */
  env?: Record<string, string | null | undefined>;
  /** Optional auth route preference for probes that must mirror a concrete run route. */
  authPreference?: AuthPreference;
  /** Bypass every readiness cache for this probe without reading, writing, or clearing shared cache state. */
  fresh?: boolean;
  /** Probe only this concrete auth source; adapters must not verify unrelated routes. */
  authSource?: AuthSourceKind;
  /** Cancels active vendor probes. This runtime-only value is never part of a cache key. */
  abortSignal?: AbortSignal;
}

/** Model-inventory query bound to the credential identity that would run.
 * Kept separate from DoctorSpec so profile identity never enters the shared
 * doctor cache contract. */
export interface HarnessModelSpec extends DoctorSpec {
  credentialProfile?: CredentialProfile | null;
}

export interface HarnessProcessingSpec extends HarnessModelSpec {
  preference?: ProcessingPreference;
  model: string | null;
  effort: string | null;
  /** Existing monetary policy; false requests ordinary fallback before paid work. */
  allowPaid?: boolean;
}

export interface PreparedHarnessProcessing {
  model: string | null;
  receipt: ProcessingReceipt;
  costBasis: ProcessingCostBasis;
}

/**
 * Why a live message did not reach the model, filled from adapter/registry
 * state only — never from vendor error prose (INV-049). The ONE vocabulary is
 * the schema's `LiveMessageReason` (control-run-message.ts); core re-exports
 * it so harness packages keep a single import path.
 */
import type { LiveMessageReason } from "@claudexor/schema";
export type { LiveMessageReason };

/**
 * Typed answer of `HarnessAdapter.message`. `accepted`: the harness's
 * documented acceptance boundary was observed (consumption unproved).
 * `delivered`: a correlated native consumption event was observed (obedience
 * unproved). `rejected`: an explicit refusal of THIS submission on a still
 * active turn. `not_active`: no eligible target existed before dispatch.
 * `unsupported`: this session has no live-input channel. `delivery_unknown`:
 * the message may have landed (transport loss, malformed reply, timeout) —
 * never "safe to resend under a new key".
 */
export interface LiveMessageResult {
  outcome:
    "accepted" | "delivered" | "rejected" | "not_active" | "unsupported" | "delivery_unknown";
  reason?: LiveMessageReason;
  nativeTurnId?: string;
}

/**
 * The contract every harness adapter implements. Adapters translate a native
 * harness's I/O into typed Claudexor events — they never contain orchestration
 * logic. External adapters may implement this as an in-tree HarnessAdapter implementation (the out-of-tree JSON-RPC bridge package was removed in v0.9).
 */
export interface HarnessAdapter {
  readonly id: string;

  /**
   * Static capability declaration available without spawning the vendor CLI.
   * Policy/admission consumers use this exact object before any live probe;
   * discover() may only overlay runtime facts such as the preferred auth
   * source. Keeping the declaration on the adapter prevents a profile-policy
   * conflict from spending a vendor call merely to learn that it must refuse.
   */
  readonly capabilityProfile?: HarnessCapabilityProfile;

  /** Detect installation/version/auth and declare capabilities. */
  discover(): Promise<HarnessManifest>;

  /** Probe capabilities and report which intents this adapter may play. */
  doctor(spec: DoctorSpec): Promise<ConformanceReport>;

  /**
   * Optional Accounts projection of the same doctor probe. Implementations
   * return readiness plus a narrow non-secret identity in one receipt so an
   * Accounts caller never launches a second native status process.
   */
  doctorForAccounts?(spec: DoctorSpec): Promise<HarnessAccountDoctorReceipt>;

  /** Run a task, streaming normalized events. */
  run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /** Optional dedicated review path (defaults to run with intent=review). */
  review?(spec: HarnessRunSpec): AsyncIterable<HarnessEvent>;

  /**
   * Optional model enumeration. Only adapters that can HONESTLY list models
   * implement this (e.g. raw-api via OpenAI-compatible `GET /v1/models`);
   * native-CLI adapters that cannot enumerate simply omit it. Must fail soft
   * (return [] on network/auth error) — never throw into a picker/consumer.
   */
  models?(spec?: HarnessModelSpec): Promise<HarnessModel[]>;

  /** Translate service intent using this account's inventory before ranking or
   * reserving spend. Discovery only; never starts a generation or changes auth. */
  prepareProcessing?(spec: HarnessProcessingSpec): Promise<PreparedHarnessProcessing>;

  /** Optional cancellation. */
  cancel?(sessionId: string): Promise<void>;

  /**
   * Optional live input into an ALREADY RUNNING session (the
   * `POST /v2/runs/:id/messages` capability). Only adapters whose
   * `capabilityProfile.live_input` is not `none` implement it; the daemon
   * answers `unsupported` when the method is absent. The adapter never
   * cancels or fails the run because of a message: every outcome is typed.
   */
  message?(
    sessionId: string,
    input: { messageId: string; text: string },
  ): Promise<LiveMessageResult>;

  /**
   * Optional per-profile readiness probe (INV-135): the doctor projection for
   * one credential profile, without asserting anything about other routes.
   * Adapters that support no profile transport simply omit it — the service
   * layer reports `unknown` availability for their profiles.
   */
  probeCredentialProfile?(
    profile: CredentialProfile,
    abortSignal?: AbortSignal,
  ): Promise<CredentialProfileStatus>;

  /**
   * Optional Accounts-only profile probe. This is the rich counterpart of
   * `probeCredentialProfile`, not an additional probe: callers choose one.
   */
  probeCredentialAccount?(
    profile: CredentialProfile,
    abortSignal?: AbortSignal,
  ): Promise<CredentialAccountProbeReceipt>;
}

/** A registry of available adapters keyed by harness id. */
export type AdapterRegistry = Map<string, HarnessAdapter>;

/**
 * Imperative answer channel for interactive harness sessions.
 *
 * The adapter calls `request()` when its native session raises a user
 * question (e.g. Claude's AskUserQuestion via the stream-json control
 * protocol) and BLOCKS that tool until the promise resolves:
 * - resolved with answers -> the adapter delivers them into the live session;
 * - resolved with null (timeout / decline / no listener) -> the adapter
 *   declines benignly and the model continues with assumptions.
 *
 * The channel is smuggled through `spec.extra` (duck-typed, same pattern as
 * the abort signal) because HarnessRunSpec is a serializable schema shape.
 */
export interface InteractionChannel {
  request(req: InteractionRequest): Promise<InteractionAnswerSet | null>;
  /** Number of questions currently awaiting an answer. Lets stream watchdogs
   * treat waiting-on-user as legitimate silence instead of a wedged harness. */
  pendingCount?(): number;
  /** Monotonic begin/end transition counter. Unlike a boolean poll, this lets
   * watchdogs detect a complete wait-and-answer cycle between timer ticks. */
  suspensionVersion?(): number;
}

export function interactionChannelFromSpec(spec: HarnessRunSpec): InteractionChannel | undefined {
  const channel = spec.extra?.["interactionChannel"];
  if (!channel || typeof channel !== "object") return undefined;
  const candidate = channel as Partial<InteractionChannel>;
  return typeof candidate.request === "function" ? (channel as InteractionChannel) : undefined;
}
