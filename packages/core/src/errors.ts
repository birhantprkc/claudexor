/**
 * Typed error hierarchy. We fail loudly: boundaries add context, preserve the
 * original cause, and never swallow-and-continue.
 */
export class ClaudexorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class HarnessUnavailableError extends ClaudexorError {}
export class ContextOverflowError extends ClaudexorError {}
export class WorkspaceError extends ClaudexorError {}

/**
 * A known pre-start condition prevents construction of the Claudexor
 * delegation belt descriptor. Agent start may catch this exact typed error and
 * continue without Delegate while recording the durable degradation receipt;
 * errors after descriptor injection remain hard failures.
 */
export class DelegationBeltUnavailableError extends ClaudexorError {
  readonly code = "delegation_belt_unavailable";
  readonly status = 503;
}

/**
 * A run marked `execution.delegated` could not be confined to a scoped harness
 * HOME. Its caller cannot audit a confinement that silently did not happen, so
 * the attempt refuses instead of degrading onto the operator's real home (which
 * holds the daemon control token and the caller's own provider settings).
 */
export class DelegatedHomeUnavailableError extends ClaudexorError {
  readonly code = "delegated_home_unavailable";
}
