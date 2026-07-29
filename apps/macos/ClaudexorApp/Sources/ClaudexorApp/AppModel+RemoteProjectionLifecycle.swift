import ClaudexorKit

extension AppModel {
    /// Retire every daemon-authored snapshot owned by one remote location.
    /// Connection preferences and the persisted offline thread cache have a
    /// different lifetime and intentionally remain available after teardown.
    func discardRemoteDaemonProjections(at locationID: ExecutionLocationID) {
        guard locationID != .local else { return }

        remoteCredentialProfiles.removeValue(forKey: locationID)
        remoteHarnessAccounts.removeValue(forKey: locationID)
        accountsRefreshGenerations[locationID] =
            (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        suspendAccountsQuotaObserver(at: locationID, discardCursor: true)
        accountsNextUpAuthorityFresh.removeValue(forKey: locationID)

        retireHarnessProjection(at: locationID)
        remoteHarnesses.removeValue(forKey: locationID)
        remoteHarnessReadinessFresh.removeValue(forKey: locationID)
        remoteGitCapabilities.removeValue(forKey: locationID)
        retireRunApplicability(at: locationID)
        remoteSettingsSnapshots.removeValue(forKey: locationID)
        remoteQuotaResponses.removeValue(forKey: locationID)
        remoteExactAuthSources.removeValue(forKey: locationID)
        remoteSecretBackends.removeValue(forKey: locationID)
        remoteStoredSecrets.removeValue(forKey: locationID)
        remoteTrustEntries.removeValue(forKey: locationID)
        remoteProjects.removeValue(forKey: locationID)
        remoteTasks.removeValue(forKey: locationID)
        discardCancelledRunMemory(at: locationID)

        if selectedExecutionLocation == locationID {
            // Keep the selected cached summary/title, but never a transcript
            // projection or an in-flight load from the retired daemon epoch.
            threadLoadGeneration &+= 1
            selectedThreadDetail = nil
            if pendingRemoteThreadSelection?.locationID == locationID {
                pendingRemoteThreadSelection = nil
            }
        }
    }
}
