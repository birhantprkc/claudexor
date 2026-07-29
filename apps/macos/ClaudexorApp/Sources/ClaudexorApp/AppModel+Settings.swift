import ClaudexorKit
import Foundation

struct SettingsWriteResult: Sendable, Equatable {
    let succeeded: Bool
    let failureMessage: String?

    static let saved = Self(succeeded: true, failureMessage: nil)
    static func failed(_ message: String) -> Self {
        Self(succeeded: false, failureMessage: message)
    }
}

// MARK: - Engine settings load/save
//
// Split from AppModel.swift (readability ratchet). POST /v2/settings answers
// with the fresh effective snapshot (GET's shape) — the save answer IS the
// refresh (#20 / D1, no follow-up GET).
//
// ALL settings network operations are SERIALIZED through one chain (X10/X14,
// the sol confirmation blocker): only one save/refresh is in flight at a time
// and answers apply in issue order, which the daemon's config lock makes equal
// to commit order — so the projection can never regress to older daemon truth
// (INV-002), and a superseded save can never overwrite a newer failure status.

extension AppModel {
    /// Existing connection lifecycle owners, projected through one execution-
    /// location fence. Local daemon loss retires local work only; each remote
    /// reconnect retires only work admitted against that connection instance.
    func executionLocationGeneration(for locationID: ExecutionLocationID) -> Int {
        if locationID == .local { return settingsEpoch }
        guard let id = locationID.remoteConnectionID else { return 0 }
        return remoteConnectionGenerations[id] ?? 0
    }

    /// Append an operation to the settings chain: it starts only after every
    /// previously enqueued settings operation finished. The chain tail is
    /// swapped synchronously (no await between read and write), so enqueue
    /// order IS issue order.
    private func enqueueSettingsOperation<T: Sendable>(
        _ op: @escaping @MainActor () async -> T
    ) async -> T {
        let previous = settingsChain
        let task = Task { @MainActor in
            await previous?.value
            return await op()
        }
        settingsChain = Task { _ = await task.value }
        return await task.value
    }

    @discardableResult
    func refreshSettings(
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> String? {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let generation = executionLocationGeneration(for: locationID)
        let token = UUID()
        settingsLoadTokens[locationID] = token
        settingsLoadStates[locationID] = .loading
        let error = await enqueueSettingsOperation { [weak self] () -> String? in
            guard let self else { return "Settings stopped loading." }
            guard self.executionLocationGeneration(for: locationID) == generation else {
                return "Settings context changed while loading. Retry."
            }
            guard let requestClient = self.gateway(for: locationID) else {
                return "Engine offline — reconnect to load settings."
            }
            do {
                let answer = try await requestClient.settings()
                // Re-check AFTER the await (X24): the location's connection
                // generation may have changed while the request was in flight;
                // a late answer must not repopulate retired state.
                guard self.executionLocationGeneration(for: locationID) == generation,
                      self.isCurrentGateway(requestClient, at: locationID),
                      self.settingsLoadTokens[locationID] == token
                else { return "Settings context changed while loading. Retry." }
                if locationID == .local {
                    self.settingsSnapshot = answer
                } else {
                    self.remoteSettingsSnapshots[locationID] = answer
                }
                return nil
            } catch {
                guard self.executionLocationGeneration(for: locationID) == generation,
                      self.isCurrentGateway(requestClient, at: locationID),
                      self.settingsLoadTokens[locationID] == token
                else { return "Settings context changed while loading. Retry." }
                return "Could not load settings: \(self.userMessage(for: error))"
            }
        }
        guard settingsLoadTokens[locationID] == token else { return error }
        settingsLoadTokens.removeValue(forKey: locationID)
        settingsLoadStates[locationID] = error.map(ProjectionLoadState.failed) ?? .loaded
        if activeExecutionLocation == locationID {
            settingsStatus = error
        }
        return error
    }

    func saveSettings(_ patch: SettingsUpdateRequest) async -> Bool {
        let locationID = activeExecutionLocation
        let generation = executionLocationGeneration(for: locationID)
        return await saveSettings(patch, at: locationID, admittedGeneration: generation)
    }

    /// Save against the location and connection generation captured when an
    /// edit was admitted. Debounced callers must not retarget a write merely
    /// because the user selected another execution location while the timer slept.
    func saveSettings(
        _ patch: SettingsUpdateRequest,
        at locationID: ExecutionLocationID,
        admittedGeneration generation: Int
    ) async -> Bool {
        let result = await writeSettings(
            patch,
            at: locationID,
            admittedGeneration: generation
        )
        // `settingsStatus` is a legacy shared channel used by the Accounts
        // toggles. Field-owned autosave consumes the operation-local result
        // directly and never publishes here, so a hidden location cannot paint
        // status into the currently visible location.
        if activeExecutionLocation == locationID,
           executionLocationGeneration(for: locationID) == generation
        {
            settingsStatus = result.succeeded
                ? "Saved engine defaults."
                : result.failureMessage
        }
        return result.succeeded
    }

    /// Result-bearing variant used by independent autosave lanes. The failure
    /// travels with this exact serialized operation, so a later lane cannot
    /// overwrite a shared status string before the caller renders its error.
    func writeSettings(
        _ patch: SettingsUpdateRequest,
        at locationID: ExecutionLocationID,
        admittedGeneration generation: Int
    ) async -> SettingsWriteResult {
        return await enqueueSettingsOperation { [weak self] in
            guard let self,
                  self.executionLocationGeneration(for: locationID) == generation
            else {
                return .failed("Settings context changed before this save could start.")
            }
            guard let requestClient = self.gateway(for: locationID) else {
                let message = "Engine offline: reconnect before saving settings."
                return .failed(message)
            }
            do {
                let answer = try await requestClient.updateSettings(patch)
                // Re-check AFTER the await (X24): a response landing past a
                // local outage or remote reconnect must not write retired state.
                guard self.executionLocationGeneration(for: locationID) == generation,
                      self.isCurrentGateway(requestClient, at: locationID)
                else {
                    return .failed("Settings context changed while this save was in flight.")
                }
                if locationID == .local {
                    self.settingsSnapshot = answer
                } else {
                    self.remoteSettingsSnapshots[locationID] = answer
                }
                if self.settingsLoadTokens[locationID] == nil {
                    self.settingsLoadStates[locationID] = .loaded
                }
                // The POST response is the settings authority and settles this
                // lane now. Harness readiness is a derived projection: refresh
                // it on the per-location latest-wins lane under its own
                // ticket, client, and location-generation fence, without
                // holding the autosave result open.
                _ = self.scheduleHarnessRefresh(locationID: locationID)
                return .saved
            } catch {
                let message = "Could not save settings: \(error)"
                guard self.executionLocationGeneration(for: locationID) == generation,
                      self.isCurrentGateway(requestClient, at: locationID)
                else {
                    return .failed("Settings context changed while this save was in flight.")
                }
                return .failed(message)
            }
        }
    }
}
