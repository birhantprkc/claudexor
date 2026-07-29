import type {
  AccessProfile,
  Attachment,
  AttachmentInputClass,
  ExternalContextPolicy,
  ImplementationTransport,
  Intent,
  RequestRequirementResolution,
} from "@claudexor/schema";
import { HarnessUnavailableError } from "@claudexor/core";

export interface BrowserLaneRequirementInput {
  harnessId: string;
  requested: boolean;
  manifestCapable: boolean;
  webPolicy: ExternalContextPolicy;
  access: AccessProfile;
}

export interface DelegationLaneRequirementInput {
  harnessId: string;
  requested: boolean;
  runtimeAvailable: boolean;
  manifestCapable: boolean;
  requiresFullAccess: boolean;
  fullAccess: boolean;
}

export type AttachmentAdmissionReason =
  "admitted" | "unsupported_input" | "max_bytes_exceeded" | "max_count_exceeded";

export interface AttachmentLaneAdmission {
  harnessId: string;
  admitted: boolean;
  reason: AttachmentAdmissionReason;
  message: string | null;
  attachmentResourceId?: string;
}

export type AttachmentPoolMode = "auto" | "explicit";

export interface AttachmentPoolLane {
  harnessId: string;
  declarations: AttachmentInputClass[] | null;
  available: boolean;
}

export interface AttachmentPoolAdmission {
  outcome: "admitted" | "degraded" | "refused";
  admittedHarnessIds: string[];
  rejected: AttachmentLaneAdmission[];
  message: string | null;
}

/** Access profiles that map to an unsandboxed/full-access harness lane. */
export function isFullAccess(access: AccessProfile): boolean {
  return access === "full" || access === "external_sandbox_full";
}

export class RequestRequirementsError extends HarnessUnavailableError {
  readonly code = "browser_unavailable";

  constructor(
    message: string,
    readonly resolutions: RequestRequirementResolution[],
  ) {
    super(message);
  }
}

/** One preflight owner for requested-vs-effective lane capability truth. */
export class RequestRequirementsResolver {
  /** Patch producers only read; the engine owns materialization and delivery. */
  adapterAccess(
    intent: Intent,
    implementationTransport: ImplementationTransport,
    requestedAccess: AccessProfile,
  ): AccessProfile {
    return implementationTransport === "git_patch_envelope" &&
      (intent === "implement" || intent === "synthesize")
      ? "readonly"
      : requestedAccess;
  }

  assertConvergenceWorkspace(
    inPlace: boolean,
    routes: { implementationTransport: ImplementationTransport }[],
  ): void {
    if (inPlace && routes.some((route) => route.implementationTransport === "git_patch_envelope")) {
      throw new HarnessUnavailableError(
        "in-place convergence is unavailable for git_patch_envelope adapters; use an isolated run or a single agent attempt",
      );
    }
  }

  /** Typed finite-descriptor admission for one selected harness lane. */
  resolveAttachmentLane(
    harnessId: string,
    attachments: Attachment[],
    declarations: AttachmentInputClass[],
  ): AttachmentLaneAdmission {
    for (const attachment of attachments) {
      const matching = declarations.filter(
        (candidate) =>
          candidate.kind === attachment.kind && candidate.mime_types.includes(attachment.mime),
      );
      if (matching.length === 0) {
        return {
          harnessId,
          admitted: false,
          reason: "unsupported_input",
          attachmentResourceId: attachment.resource_id,
          message: `${harnessId} cannot receive every mandatory attachment: ${attachment.kind} ${attachment.mime} is unsupported; choose a compatible harness pool or remove the attachment`,
        };
      }

      const sizeCompatible = matching.filter(
        (declaration) => attachment.size_bytes <= declaration.max_bytes,
      );
      if (sizeCompatible.length === 0) {
        const maxBytes = Math.max(...matching.map((declaration) => declaration.max_bytes));
        return {
          harnessId,
          admitted: false,
          reason: "max_bytes_exceeded",
          attachmentResourceId: attachment.resource_id,
          message: `${harnessId} cannot receive every mandatory attachment: ${attachment.name || attachment.resource_id} is ${attachment.size_bytes} bytes (max ${maxBytes} for ${attachment.mime}); choose a compatible harness pool or remove the attachment`,
        };
      }

      const countCompatible = sizeCompatible.find((declaration) => {
        const count = attachments.filter(
          (item) => item.kind === declaration.kind && declaration.mime_types.includes(item.mime),
        ).length;
        return count <= declaration.max_count;
      });
      if (!countCompatible) {
        const declaration = sizeCompatible.reduce((best, candidate) =>
          candidate.max_count > best.max_count ? candidate : best,
        );
        const count = attachments.filter(
          (item) => item.kind === declaration.kind && declaration.mime_types.includes(item.mime),
        ).length;
        return {
          harnessId,
          admitted: false,
          reason: "max_count_exceeded",
          attachmentResourceId: attachment.resource_id,
          message: `${harnessId} cannot receive every mandatory attachment: ${count} ${declaration.kind} attachments exceed max_count ${declaration.max_count}; choose a compatible harness pool or remove the attachment`,
        };
      }
    }
    return { harnessId, admitted: true, reason: "admitted", message: null };
  }

  /**
   * Canonical pool aggregation for mandatory attachments. Auto drops lanes
   * that are unavailable or incompatible; an explicit pool is atomic. Lane
   * identity is stable and de-duplicated before admission.
   */
  resolveAttachmentPool(
    poolMode: AttachmentPoolMode,
    attachments: Attachment[],
    lanes: AttachmentPoolLane[],
  ): AttachmentPoolAdmission {
    const seen = new Set<string>();
    const projected = lanes.filter((lane) => {
      if (poolMode === "auto" && !lane.available) return false;
      if (seen.has(lane.harnessId)) return false;
      seen.add(lane.harnessId);
      return true;
    });

    if (attachments.length > 0 && projected.length === 0) {
      return {
        outcome: "refused",
        admittedHarnessIds: [],
        rejected: [],
        message: "no available harness lane can receive the selected attachments",
      };
    }

    const admissions = projected.map((lane) =>
      this.resolveAttachmentLane(lane.harnessId, attachments, lane.declarations ?? []),
    );
    const rejected = admissions.filter((admission) => !admission.admitted);
    const admittedHarnessIds = admissions
      .filter((admission) => admission.admitted)
      .map((admission) => admission.harnessId);
    if (rejected.length === 0) {
      return { outcome: "admitted", admittedHarnessIds, rejected: [], message: null };
    }

    const detail = rejected
      .map((admission) => admission.message)
      .filter((message): message is string => message !== null)
      .join("; ");
    if (poolMode === "explicit" || admittedHarnessIds.length === 0) {
      return {
        outcome: "refused",
        admittedHarnessIds: [],
        rejected,
        message: detail || "no available harness lane can receive the selected attachments",
      };
    }
    return {
      outcome: "degraded",
      admittedHarnessIds,
      rejected,
      message: detail,
    };
  }

  browserSpec(
    resolution: RequestRequirementResolution,
    outputDir: string,
  ): { output_dir: string; headless: boolean } | null {
    return resolution.effective ? { output_dir: outputDir, headless: false } : null;
  }

  resolveBrowser(input: BrowserLaneRequirementInput): RequestRequirementResolution {
    const eligible = input.manifestCapable;
    if (!input.requested) {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible,
        requested: false,
        effective: false,
        reason: "not_requested",
        evidence_refs: ["request.browser"],
      };
    }
    if (!eligible) {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: false,
        requested: true,
        effective: false,
        reason: "manifest_unsupported",
        evidence_refs: ["manifest.capabilities.browser_tool"],
      };
    }
    if (input.webPolicy === "off") {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: true,
        requested: true,
        effective: false,
        reason: "web_policy_off",
        evidence_refs: ["request.external_context_policy"],
      };
    }
    if (!isFullAccess(input.access)) {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: true,
        requested: true,
        effective: false,
        reason: "access_profile_incompatible",
        evidence_refs: ["task.access.effective_profile"],
      };
    }
    return {
      capability: "browser",
      harness_id: input.harnessId,
      eligible: true,
      requested: true,
      effective: true,
      reason: "effective",
      evidence_refs: [
        "manifest.capabilities.browser_tool",
        "request.external_context_policy",
        "task.access.effective_profile",
      ],
    };
  }

  /**
   * Per-lane deny-path enforcement receipt. No pinned adapter supports native
   * pre-write path deny today (claude needs >=2.1.208), so an eligible lane
   * does not exist and the engine's post-diff policy gate is the authoritative
   * enforcement — the receipt discloses exactly that (`postdiff_only`), never
   * implying OS/native containment that is not there.
   */
  resolveDenyPaths(harnessId: string, requested: boolean): RequestRequirementResolution {
    return {
      capability: "path_deny",
      harness_id: harnessId,
      eligible: false,
      requested,
      effective: false,
      reason: requested ? "postdiff_only" : "not_requested",
      evidence_refs: ["request.deny_paths"],
    };
  }

  /**
   * Resolve Delegate independently for each selected lane. Known pre-start
   * unavailability is a disclosed degradation, not a routing refusal; an
   * injected server that later reports startup failure is handled separately
   * by attempt telemetry and remains terminal.
   */
  resolveDelegation(input: DelegationLaneRequirementInput): RequestRequirementResolution {
    if (!input.requested) {
      return {
        capability: "delegation",
        harness_id: input.harnessId,
        eligible: input.manifestCapable,
        requested: false,
        effective: false,
        reason: "not_requested",
        evidence_refs: ["task.delegation_requested"],
      };
    }
    if (!input.manifestCapable) {
      return {
        capability: "delegation",
        harness_id: input.harnessId,
        eligible: false,
        requested: true,
        effective: false,
        reason: "manifest_unsupported",
        evidence_refs: ["manifest.capability_profile.mcp_injection"],
      };
    }
    if (!input.runtimeAvailable) {
      return {
        capability: "delegation",
        harness_id: input.harnessId,
        eligible: false,
        requested: true,
        effective: false,
        reason: "runtime_unavailable",
        evidence_refs: ["runtime.delegation_belt"],
      };
    }
    if (input.requiresFullAccess && !input.fullAccess) {
      return {
        capability: "delegation",
        harness_id: input.harnessId,
        eligible: true,
        requested: true,
        effective: false,
        reason: "access_profile_incompatible",
        evidence_refs: [
          "manifest.capability_profile.mcp_injection_requires_full_access",
          "task.access.effective_profile",
        ],
      };
    }
    return {
      capability: "delegation",
      harness_id: input.harnessId,
      eligible: true,
      requested: true,
      effective: true,
      reason: "effective",
      evidence_refs: ["runtime.delegation_belt", "manifest.capability_profile.mcp_injection"],
    };
  }

  requireEffectiveBrowser(requested: boolean, resolutions: RequestRequirementResolution[]): void {
    if (!requested || resolutions.some((resolution) => resolution.effective)) return;
    const detail = resolutions
      .map((resolution) => `${resolution.harness_id}: ${resolution.reason}`)
      .join("; ");
    throw new RequestRequirementsError(
      `browser was requested but no selected harness lane can receive it${detail ? ` (${detail})` : ""}; choose a browser-capable lane with web enabled and full access`,
      resolutions,
    );
  }
}
