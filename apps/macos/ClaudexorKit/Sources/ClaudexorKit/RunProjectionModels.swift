import Foundation

public struct RunProjectInfo: Codable, Sendable, Equatable {
    public let kind: String
    public let root: String?
    public let projectName: String?
    public let context: String
}

/// Run-level route evidence: requested vs STREAM-OBSERVED model. `verified`
/// is true only when the harness stream itself disclosed a model identity.
public struct RouteInfo: Codable, Sendable, Equatable {
    public let requestedModel: String?
    public let observedModel: String?
    public let harnessId: String?
    public let verified: Bool?
}

/// Engine-owned Delegate outcome facts. `requested` records the user's
/// permission, `effective` records whether the Claudexor belt was actually
/// injected, and `used` records typed evidence that the harness called a
/// Claudexor belt tool. A capable belt that the model did not use is therefore
/// distinct from a pre-start downgrade. `reason` is the daemon's closed state/
/// cause vocabulary (`pending`, `not_requested`, `injected_unused`, `used`,
/// the three pre-start causes, `partially_degraded`, or `startup_failed`).
public struct RunDelegationInfo: Codable, Sendable, Equatable, Hashable {
    public let requested: Bool
    public let effective: Bool
    public let used: Bool
    public let reason: String
    /// Engine-owned recovery guidance for degraded or failed Delegate setup.
    /// Nil for healthy states and legacy runtimes that did not project it.
    public let remediation: String?

    public init(
        requested: Bool,
        effective: Bool,
        used: Bool,
        reason: String,
        remediation: String? = nil
    ) {
        self.requested = requested
        self.effective = effective
        self.used = used
        self.reason = reason
        self.remediation = remediation
    }
}
