import Foundation
import ClaudexorKit

// MARK: - Harness readiness refresh (INV-124 split from AppModel.swift)
//
// The harness-list refresh (typed readiness rows included), the exact
// auth-source refresh, and their readiness-text projections. Split out whole
// — zero behavior change; `private` members became fileprivate-equivalent
// module internals only where the extension boundary required it.

extension AppModel {
    func storeHarnessSnapshot(
        _ harnesses: [HarnessStatus],
        git: WorkspaceGitCapability?,
        at locationID: ExecutionLocationID
    ) {
        let mapped = Self.mapHarnessStatuses(harnesses)
        var exactSources: [HarnessFamily: [AuthSourceKind: HarnessAuthSource]] = [:]
        for info in mapped {
            for source in info.authSources {
                guard let kind = AuthSourceKind(rawValue: source.source) else { continue }
                exactSources[info.family, default: [:]][kind] = source
            }
        }
        if locationID == .local {
            liveHarnesses = mapped
            exactAuthSources = exactSources
            harnessReadinessFresh = true
            gitCapability = git
        } else {
            remoteHarnesses[locationID] = mapped
            remoteExactAuthSources[locationID] = exactSources
            remoteHarnessReadinessFresh[locationID] = true
            if let git { remoteGitCapabilities[locationID] = git }
            else { remoteGitCapabilities.removeValue(forKey: locationID) }
        }
    }

    @discardableResult
    func refreshHarnesses(
        fresh: Bool = false,
        locationID requestedLocationID: ExecutionLocationID? = nil,
        markStaleOnFailure: Bool = false
    ) async -> Bool {
        let locationID = requestedLocationID ?? activeExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            if locationID == .local { gitCapability = nil }
            else { remoteGitCapabilities.removeValue(forKey: locationID) }
            if markStaleOnFailure {
                if locationID == .local {
                    harnessReadinessFresh = false
                } else {
                    remoteHarnessReadinessFresh[locationID] = false
                }
            }
            return false
        }
        do {
            let response = try await requestClient.listHarnessStatus(fresh: fresh)
            guard gateway(for: locationID) === requestClient else { return false }
            storeHarnessSnapshot(response.harnesses, git: response.git, at: locationID)
            return true
        } catch {
            guard gateway(for: locationID) === requestClient else { return false }
            // Keep the last server-authored rows unchanged. An explicit
            // Accounts refresh expires their CLIENT freshness instead of
            // fabricating a synthetic server health verdict.
            if markStaleOnFailure {
                if locationID == .local {
                    harnessReadinessFresh = false
                } else {
                    remoteHarnessReadinessFresh[locationID] = false
                }
            }
            if locationID == .local { gitCapability = nil }
            else { remoteGitCapabilities.removeValue(forKey: locationID) }
            return false
        }
    }

    static func mapHarnessStatuses(_ statuses: [HarnessStatus]) -> [HarnessInfo] {
        statuses.map { status in
            let family = HarnessFamily(rawValue: status.id)
            let health = HarnessHealth(rawValue: status.status) ?? .unavailable
            let version =
                status.manifest?["version"]?.stringValue
                ?? status.manifest?["adapter_version"]?.stringValue ?? "unknown"
            let auth = Self.harnessReadinessText(status: status, health: health)
            let attachmentInputs = Self.attachmentInputs(manifest: status.manifest)
            let acceptsBrowser =
                status.manifest?["capabilities"]?["browser_tool"]?.boolValue ?? false
            let effortLevels: [String] = {
                // Schema truth: HarnessCapabilities.effort_levels lives under
                // manifest.capabilities.
                guard
                    case .array(let values) =
                        status.manifest?["capabilities"]?["effort_levels"]
                else { return [] }
                return values.compactMap(\.stringValue)
            }()
            let modelEffortLevels: [String: [String]] = {
                guard
                    case .object(let entries) =
                        status.manifest?["capabilities"]?["model_effort_levels"]
                else { return [:] }
                return entries.compactMapValues { entry in
                    guard case .array(let values) = entry["levels"] else {
                        return nil
                    }
                    let levels = values.compactMap(\.stringValue)
                    return levels.isEmpty ? nil : levels
                }
            }()
            return HarnessInfo(
                family: family, health: health, version: version, auth: auth,
                authSources: status.authSources,
                intents: status.enabledIntents,
                routableIntents: status.routableIntents,
                reasons: status.reasons ?? [], readiness: status.readiness,
                attachmentInputs: attachmentInputs,
                acceptsBrowser: acceptsBrowser,
                delegation: status.delegation,
                effortLevels: effortLevels,
                modelEffortLevels: modelEffortLevels)
        }
    }

    @discardableResult
    func refreshAuthReadinessAfterSetupLifecycle(for family: HarnessFamily, job: SetupJob?) async -> Bool {
        guard let request = family.authReadinessRequest(after: job) else { return false }
        let refreshed = await refreshAuthReadiness(for: family, request: request)
        // The card renders daemon-NORMALIZED rows, which only a harness-list
        // refresh rebuilds — else the sheet's own recheck left them stale.
        _ = await refreshHarnesses(fresh: true, markStaleOnFailure: true)
        return refreshed
    }

    @discardableResult
    func refreshAuthReadiness(for family: HarnessFamily, request: AuthReadinessRefreshRequest) async -> Bool {
        let locationID = activeExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return false }
        do {
            let response = try await requestClient.refreshAuthReadiness(
                harnessId: family.rawValue, request: request)
            guard gateway(for: locationID) === requestClient else { return false }
            let source = HarnessAuthSource(
                source: response.readiness.source.rawValue,
                availability: response.readiness.availability.rawValue,
                verification: response.readiness.verification.rawValue,
                detail: response.readiness.detail
            )
            if locationID == .local {
                exactAuthSources[family, default: [:]][response.requestedSource] = source
            } else {
                remoteExactAuthSources[locationID, default: [:]][family, default: [:]][
                    response.requestedSource] = source
            }
            var rows = locationID == .local
                ? liveHarnesses
                : (remoteHarnesses[locationID] ?? [])
            if let index = rows.firstIndex(where: { $0.family == family }) {
                if let sourceIndex = rows[index].authSources.firstIndex(where: {
                    $0.source == source.source
                }) {
                    rows[index].authSources[sourceIndex] = source
                } else {
                    rows[index].authSources.append(source)
                }
            }
            if locationID == .local {
                liveHarnesses = rows
            } else {
                remoteHarnesses[locationID] = rows
            }
            return true
        } catch {
            return false
        }
    }

    func authSource(for family: HarnessFamily, source: AuthSourceKind) -> HarnessAuthSource? {
        let exact = activeExecutionLocation == .local
            ? exactAuthSources[family]?[source]
            : remoteExactAuthSources[activeExecutionLocation]?[family]?[source]
        return exact
            ?? harnessInfo(for: family)?.authSources.first { $0.source == source.rawValue }
    }

    /// One overall sentence — the ROWS own every smoke/source/model detail
    /// (one presentational owner per fact, INV-134; F4 final review #3).
    private static func harnessReadinessText(status: HarnessStatus, health: HarnessHealth) -> String {
        switch health {
        case .ok: return "Ready by doctor."
        case .degraded: return "Not ready: doctor degraded."
        case .unavailable: return "Not ready: unavailable."
        }
    }

}
