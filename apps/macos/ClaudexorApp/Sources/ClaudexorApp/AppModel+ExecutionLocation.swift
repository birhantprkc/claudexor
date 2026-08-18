import ClaudexorKit

extension AppModel {
    var activeTrustEntries: [TrustEntry] {
        activeExecutionLocation == .local
            ? trustEntries
            : (remoteTrustEntries[activeExecutionLocation] ?? [])
    }

    var activeExecutionLocation: ExecutionLocationID {
        selectedThreadId == nil ? draftExecutionLocation : selectedExecutionLocation
    }

    var harnesses: [HarnessInfo] {
        activeExecutionLocation == .local
            ? liveHarnesses
            : (remoteHarnesses[activeExecutionLocation] ?? [])
    }

    var activeHarnessReadinessFresh: Bool {
        activeExecutionLocation == .local
            ? harnessReadinessFresh != false
            : remoteHarnessReadinessFresh[activeExecutionLocation] != false
    }

    var activeGitCapability: WorkspaceGitCapability? {
        activeExecutionLocation == .local
            ? gitCapability
            : remoteGitCapabilities[activeExecutionLocation]
    }

    var activeSettingsSnapshot: SettingsSnapshot? {
        activeExecutionLocation == .local
            ? settingsSnapshot
            : remoteSettingsSnapshots[activeExecutionLocation]
    }

    var activeSettingsLoadState: ProjectionLoadState {
        settingsLoadStates[activeExecutionLocation]
            ?? (activeSettingsSnapshot == nil ? .idle : .loaded)
    }

    /// The persisted model for the composer’s exact execution location. Keep
    /// this projection beside the snapshot owner so remote controls never
    /// accidentally narrow against local defaults.
    func activeDefaultModel(for harnessID: String) -> String? {
        activeSettingsSnapshot?.harnesses?[harnessID]?.defaultModel
    }

    var activeQuotaResponse: ControlQuotaResponse? {
        activeExecutionLocation == .local
            ? quotaResponse
            : remoteQuotaResponses[activeExecutionLocation]
    }

    var activeSecretBackend: String {
        activeExecutionLocation == .local
            ? secretBackend
            : (remoteSecretBackends[activeExecutionLocation] ?? "unknown")
    }

    var activeStoredSecrets: [SecretInfo] {
        activeExecutionLocation == .local
            ? storedSecrets
            : (remoteStoredSecrets[activeExecutionLocation] ?? [])
    }

    var activeCredentialProfiles: [CredentialProfileEntry] {
        activeExecutionLocation == .local
            ? credentialProfiles
            : (remoteCredentialProfiles[activeExecutionLocation] ?? [])
    }

    var activeAccountPools: [HarnessAccountPool] {
        activeExecutionLocation == .local
            ? accountPools
            : (remoteAccountPools[activeExecutionLocation] ?? [])
    }

    /// Controls enumerate doctor truth, not a compiled enum. Built-ins remain
    /// available before the first successful refresh; any adapter returned by
    /// the daemon appears without a Swift patch.
    var selectableHarnesses: [HarnessFamily] {
        let live = harnesses.map(\.family).filter { $0 != .fake }
        return live.isEmpty ? HarnessFamily.builtIns : live
    }

    var defaultRoutingGoal: String { activeSettingsSnapshot?.routing.goal ?? "auto" }

    var defaultMaxUsdPerRun: Double? {
        activeSettingsSnapshot?.budget.paidBudgetPerRun.finiteMaxUsd
    }

    var tasks: [TaskRun] { liveTasks }

    func task(_ id: String, at locationID: ExecutionLocationID) -> TaskRun? {
        if locationID == .local {
            return tasks.first { $0.id == id }
        }
        return remoteTasks[locationID]?.first { $0.id == id }
    }

    func task(_ id: String) -> TaskRun? {
        task(id, at: activeExecutionLocation)
    }

    func mutateTask(
        _ id: String,
        at locationID: ExecutionLocationID,
        _ body: (inout TaskRun) -> Void
    ) {
        if locationID == .local {
            guard let index = liveTasks.firstIndex(where: {
                $0.id == id || $0.resolvedRunId == id
            }) else { return }
            body(&liveTasks[index])
            return
        }
        guard let index = remoteTasks[locationID]?.firstIndex(where: {
            $0.id == id || $0.resolvedRunId == id
        })
        else { return }
        body(&remoteTasks[locationID]![index])
    }

    func threadSummary(
        _ id: String,
        at locationID: ExecutionLocationID
    ) -> ThreadSummary? {
        if locationID == .local {
            return threads.first { $0.id == id }
        }
        return remoteThreadCache.first {
            $0.locationID == locationID && $0.thread.id == id
        }?.thread
    }

    func locatedRunKey(_ id: String, at locationID: ExecutionLocationID) -> String {
        "\(locationID.rawValue)|\(id)"
    }
}
