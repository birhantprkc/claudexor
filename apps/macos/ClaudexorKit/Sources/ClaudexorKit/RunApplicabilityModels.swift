import Foundation

public enum RunApplicabilityShape: String, Sendable, Hashable {
    case readOnly = "read_only"
    case agentConvergence = "agent_convergence"
    case agentOther = "agent_other"
}

public enum RunApplicabilityWorkspace: String, Sendable, Hashable {
    case inPlace = "in_place"
    case isolated
}

public struct RunGitApplicabilityCell: Codable, Sendable, Equatable {
    public let applicable: Bool
    public let requiresGit: Bool
    public let code: String?
    public let reason: String?
    public let remediation: String?
}

public struct RunGitApplicabilityWorkspaceCells: Codable, Sendable, Equatable {
    public let readOnly: RunGitApplicabilityCell
    public let agentConvergence: RunGitApplicabilityCell
    public let agentOther: RunGitApplicabilityCell

    enum CodingKeys: String, CodingKey {
        case readOnly = "read_only"
        case agentConvergence = "agent_convergence"
        case agentOther = "agent_other"
    }

    public func cell(for shape: RunApplicabilityShape) -> RunGitApplicabilityCell {
        switch shape {
        case .readOnly: readOnly
        case .agentConvergence: agentConvergence
        case .agentOther: agentOther
        }
    }
}

public struct RunGitApplicabilityMatrix: Codable, Sendable, Equatable {
    public let inPlace: RunGitApplicabilityWorkspaceCells
    public let isolated: RunGitApplicabilityWorkspaceCells

    enum CodingKeys: String, CodingKey {
        case inPlace = "in_place"
        case isolated
    }

    public func cell(
        workspace: RunApplicabilityWorkspace,
        shape: RunApplicabilityShape
    ) -> RunGitApplicabilityCell {
        switch workspace {
        case .inPlace: inPlace.cell(for: shape)
        case .isolated: isolated.cell(for: shape)
        }
    }
}

/// Git-only applicability. Harness/auth/trust/attachment readiness is separate.
public struct ControlRunApplicabilityResponse: Codable, Sendable, Equatable {
    public let repoRoot: String
    public let git: WorkspaceGitCapability
    public let matrix: RunGitApplicabilityMatrix
}
