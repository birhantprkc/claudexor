import Foundation

/// Pure projection of raw `QuotaSnapshot`s into what the sidebar footer and
/// the quota detail actually render (W17, R15/Quiz-6a):
///
/// - ONE group per `(harness, credential_route)` — the server keeps cooldown
///   snapshots as a SEPARATE source for the same subject, which naively renders
///   as a duplicate card; grouping folds them back together.
/// - Every primary usage window is preserved as its own row. A window is
///   hidden only when SUPERSEDED (an older copy of the same window id carried
///   by another snapshot of the group — the cooldown snapshot clones the usage
///   constraints it knew about).
/// - A cooldown is an OVERLAY BADGE on the group, never a standalone card, and
///   it is hidden once EXPIRED (cooldown_until in the past).
///
/// Kept in ClaudexorKit as a pure value transform so the merge/dedupe/expiry
/// semantics are unit-tested without the UI (ComposerTurnState precedent).
public enum QuotaPresentation {
    /// One usage window row (a vendor quota window, e.g. "5h" / "Week").
    public struct Window: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let usedRatio: Double?
        public let resetsAt: String?
        /// Empty/nil is account-wide; a non-empty list is model-scoped.
        public let appliesToModels: [String]?
        /// Freshness of the snapshot this window's FRESHEST copy came from.
        public let freshness: String
    }

    /// One server-declared model-scoped exhaustion. The renderer may label it,
    /// but must not promote it to account-wide exhaustion.
    public struct ScopedExhaustion: Identifiable, Equatable, Sendable {
        public let constraintId: String
        public let appliesToModels: [String]
        public let resetsAt: String?
        public var id: String {
            "\(constraintId):\(appliesToModels.sorted().joined(separator: ","))"
        }

        public var scopeLabel: String {
            QuotaPresentation.modelScopeLabel(appliesToModels)
        }
    }

    /// A deterministic fold of every snapshot's server-authored availability.
    /// No ratio is consulted to produce this value.
    public struct Availability: Equatable, Sendable {
        public let state: String
        public let blockingConstraints: [String]
        public let resetsAt: String?
    }

    /// Provenance line for the detail popover (one per contributing snapshot).
    public struct Source: Identifiable, Equatable, Sendable {
        public let source: String
        public let observedAt: String
        public let freshness: String
        public var id: String { "\(source):\(observedAt)" }
    }

    /// All quota truth for one `(harness, credential_route, profile)` subject.
    public struct Group: Identifiable, Equatable, Sendable {
        public let harness: String
        /// Raw wire route (`vendor_native` / `managed_api_key` / `local`).
        public let credentialRoute: String
        /// Credential profile the quota belongs to (INV-135); nil = the
        /// engine-default identity. Distinct profiles NEVER merge into one chip.
        public let subjectId: String?
        public let planLabel: String?
        /// Freshness of the newest contributing snapshot (the chip's dot).
        public let freshness: String
        public let windows: [Window]
        public let availability: Availability?
        public let scopedExhaustions: [ScopedExhaustion]
        /// ACTIVE cooldown end (ISO), nil when none or already expired.
        public let cooldownUntil: String?
        public let sources: [Source]
        public var id: String { "\(harness):\(credentialRoute):\(subjectId ?? "")" }

        /// Human label for the credential route ("Subscription" / "API key" /
        /// "Local"); unknown wire values degrade to a cleaned-up raw string
        /// instead of being hidden or coerced.
        public var routeLabel: String { humanizeCredentialRoute(credentialRoute) }

        /// The nearest upcoming reset across the group's windows (chip text).
        public var nextResetAt: String? {
            windows
                .compactMap(\.resetsAt)
                .compactMap { value in parseOffsetTimestamp(value).map { (value, $0) } }
                .min { $0.1 < $1.1 }?.0
        }
        /// True when every renderable usage window is model-scoped.
        public var hasOnlyScopedWindows: Bool {
            !windows.isEmpty && windows.allSatisfy { !($0.appliesToModels ?? []).isEmpty }
        }
    }

    public static func groups(from snapshots: [QuotaSnapshot], now: Date = Date()) -> [Group] {
        let byRoute = Dictionary(grouping: snapshots) {
            "\($0.subject.harness):\($0.subject.credentialRoute):\($0.subject.subjectId ?? "")"
        }
        return byRoute.values.compactMap { group -> Group? in
            guard let subject = group.first?.subject else { return nil }
            // Newest snapshot first: its window copies win the dedupe and its
            // freshness speaks for the chip.
            let ordered = group.sorted { observedDate($0) > observedDate($1) }
            var windows: [Window] = []
            var seen = Set<String>()
            var cooldownEnd: Date?
            var cooldownRaw: String?
            var availabilityStates: [String] = []
            var blockingConstraints = Set<String>()
            var availabilityResets: [(String, Date)] = []
            var scopedByID: [String: ScopedExhaustion] = [:]
            for snapshot in ordered {
                if let availability = snapshot.availability {
                    availabilityStates.append(availability.state)
                    blockingConstraints.formUnion(availability.blockingConstraints)
                    if let reset = availability.resetsAt,
                       let date = parseOffsetTimestamp(reset)
                    {
                        availabilityResets.append((reset, date))
                    }
                    for scoped in availability.modelScopedExhaustions {
                        let value = ScopedExhaustion(
                            constraintId: scoped.constraintId,
                            appliesToModels: scoped.appliesToModels,
                            resetsAt: scoped.resetsAt)
                        // Newest snapshot wins an exact duplicate; distinct model
                        // scopes remain visible and are sorted below.
                        if scopedByID[value.id] == nil { scopedByID[value.id] = value }
                    }
                }
                for constraint in snapshot.constraints {
                    if let until = constraint.cooldownUntil, let date = parseOffsetTimestamp(until) {
                        if date > now, date > (cooldownEnd ?? .distantPast) {
                            cooldownEnd = date
                            cooldownRaw = until
                        }
                    }
                    // The synthetic cooldown constraint is a badge, not a usage
                    // window; an older duplicate of an already-kept window id is
                    // superseded — the ONLY two things this projection hides.
                    if constraint.id == "cooldown" { continue }
                    if !seen.insert(constraint.id).inserted { continue }
                    windows.append(Window(
                        id: constraint.id,
                        label: constraint.label,
                        usedRatio: constraint.usedRatio,
                        resetsAt: constraint.resetsAt,
                        appliesToModels: constraint.appliesToModels,
                        freshness: snapshot.freshness
                    ))
                }
            }
            let foldedAvailability: Availability? = availabilityStates.isEmpty ? nil : Availability(
                state: availabilityStates.contains("exhausted")
                    ? "exhausted"
                    : availabilityStates.contains("cooldown") ? "cooldown" : "available",
                blockingConstraints: blockingConstraints.sorted(),
                resetsAt: availabilityResets.min { $0.1 < $1.1 }?.0)
            return Group(
                harness: subject.harness,
                credentialRoute: subject.credentialRoute,
                subjectId: subject.subjectId,
                planLabel: ordered.compactMap(\.subject.planLabel).first,
                freshness: ordered.first?.freshness ?? "unknown",
                windows: windows,
                availability: foldedAvailability,
                scopedExhaustions: scopedByID.values.sorted { $0.id < $1.id },
                cooldownUntil: cooldownRaw,
                sources: ordered.map {
                    Source(source: $0.source, observedAt: $0.observedAt, freshness: $0.freshness)
                }
            )
        }
        .sorted {
            ($0.harness, $0.credentialRoute, $0.subjectId ?? "") < ($1.harness, $1.credentialRoute, $1.subjectId ?? "")
        }
    }

    private static func observedDate(_ snapshot: QuotaSnapshot) -> Date {
        parseOffsetTimestamp(snapshot.observedAt) ?? .distantPast
    }

    public static func modelScopeLabel(_ models: [String]) -> String {
        var labels = Array(Set(models.map(humanizeModelScope)))
        // The server intentionally carries routing aliases together (for
        // example fable + claude-fable-5 + best). Collapse a longer versioned
        // alias when its shorter family label is present, and omit the generic
        // `best` alias when a concrete family names the scope.
        if labels.count > 1 {
            labels.removeAll { $0.caseInsensitiveCompare("Best") == .orderedSame }
        }
        labels = labels.filter { candidate in
            !labels.contains { other in
                other != candidate
                    && candidate.lowercased().hasPrefix(other.lowercased() + " ")
            }
        }.sorted()
        if labels.count == 1, let label = labels.first { return "\(label) only" }
        return labels.isEmpty ? "Scoped limits" : "\(labels.joined(separator: ", ")) only"
    }
}

private func humanizeModelScope(_ raw: String) -> String {
    let cleaned = raw
        .replacingOccurrences(of: "claude-", with: "")
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty ? raw : cleaned.capitalized
}

/// One humanizer for every wire `credential_route` value (W17/W18 share it):
/// the composer/run-detail language is "Subscription" / "API key"; unknown
/// future values degrade honestly to a readable raw instead of a blank.
public func humanizeCredentialRoute(_ raw: String) -> String {
    switch CredentialRoute(rawValue: raw) {
    case .vendorNative: return "Subscription"
    case .managedAPIKey: return "API key"
    case .local: return "Local"
    case nil: return raw.replacingOccurrences(of: "_", with: " ").capitalized
    }
}
