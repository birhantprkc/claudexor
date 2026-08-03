import Foundation

// User-level trust wire models (per-repo full-access grants). Split from
// Models.swift — one coherent owner for the /trust shapes, the same way the
// settings and run-detail projections already have theirs.

/// One per-repo trust file (user-level, outside versioned repo config).
/// `repoRoot` is nil for legacy files written before provenance stamping —
/// those are disclosed as revocable only via `claudexor trust` in the repo.
public struct TrustEntry: Codable, Sendable, Identifiable, Equatable {
    public let repoRoot: String?
    public let path: String
    public let allowFullAccess: Bool
    public let accessDefault: String
    public var id: String { path }
}

public struct TrustListResponse: Codable, Sendable, Equatable {
    public let entries: [TrustEntry]
}

/// NARROW by design: exactly {repoRoot, allowFullAccess} — the only trust
/// field the control surface may write; everything else stays CLI-only.
public struct TrustUpdateRequest: Codable, Sendable, Equatable {
    public let repoRoot: String
    public let allowFullAccess: Bool
    public init(repoRoot: String, allowFullAccess: Bool) {
        self.repoRoot = repoRoot
        self.allowFullAccess = allowFullAccess
    }
}
