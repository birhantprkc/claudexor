import Foundation
import ClaudexorKit

// MARK: - Cached Accounts registry hydration

extension AppModel {
    var activeAccountsRegistryLoadState: ProjectionLoadState {
        accountsRegistryLoadStates[activeExecutionLocation]
            ?? (activeCredentialProfiles.isEmpty ? .idle : .loaded)
    }

    /// Cached registry hydration (INV-135). Opening Accounts and connect use
    /// this lighter endpoint; it never performs the expensive quota/provider
    /// snapshot and never claims atomic `next_up` authority.
    func refreshCredentialProfiles(locationID: ExecutionLocationID? = nil) async {
        _ = await loadCredentialProfiles(locationID: locationID)
    }

    /// A mutation receipt establishes a newer registry fence synchronously on
    /// the main actor. If an older GET owns the location lane, it is allowed to
    /// settle inertly and the lane performs exactly one trailing read. Further
    /// mutations during that read fence it and coalesce behind another pass.
    func refreshCredentialProfilesAfterMutation(
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async {
        let locationID = requestedLocationID ?? activeExecutionLocation
        accountsRegistryGenerations[locationID] =
            (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        if let inFlight = accountsRegistryLoadTasks[locationID] {
            accountsRegistryTrailingHydrations.insert(locationID)
            _ = await inFlight.value
            return
        }
        _ = await loadCredentialProfiles(locationID: locationID)
    }

    /// Mount-time hydration is an ensure, not a refresh loop. A successfully
    /// loaded empty registry is still loaded and will not refetch on every open.
    func ensureCredentialProfilesLoaded(locationID: ExecutionLocationID? = nil) async {
        let locationID = locationID ?? activeExecutionLocation
        guard accountsRegistryLoadStates[locationID] == nil
            || accountsRegistryLoadStates[locationID] == .idle
        else { return }
        _ = await loadCredentialProfiles(locationID: locationID)
    }

    /// Load credential profiles, returning the honest error on failure (batch-6
    /// item h): the accounts surface distinguishes a config/load ERROR (typed
    /// state + retry) from an EMPTY registry ("No accounts yet"). nil = loaded OK
    /// (the arrays are updated); non-nil = the failure message (last snapshot kept).
    @discardableResult
    func loadCredentialProfiles(
        locationID requestedLocationID: ExecutionLocationID? = nil,
        discardOnFailure: Bool = false
    ) async -> String? {
        _ = discardOnFailure // Stable rows are always retained on hydration failure.
        let locationID = requestedLocationID ?? activeExecutionLocation
        if let inFlight = accountsRegistryLoadTasks[locationID] {
            return await inFlight.value
        }
        guard let requestClient = gateway(for: locationID) else {
            let message = "Engine offline — reconnect to load accounts."
            accountsRegistryLoadStates[locationID] = .failed(message)
            return message
        }
        let token = UUID()
        accountsRegistryLoadTokens[locationID] = token
        accountsRegistryLoadStates[locationID] = .loading
        let task: Task<String?, Never> = Task { @MainActor [weak self] in
            guard let self else { return Optional("Accounts stopped loading.") }
            return await self.runAccountsRegistryHydrationLane(
                at: locationID, client: requestClient, token: token)
        }
        accountsRegistryLoadTasks[locationID] = task
        return await task.value
    }

    private func runAccountsRegistryHydrationLane(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        token: UUID
    ) async -> String? {
        var error: String?
        repeat {
            accountsRegistryTrailingHydrations.remove(locationID)
            accountsNextUpAuthorityFresh[locationID] = false
            let generation = (accountsRegistryGenerations[locationID] ?? 0) &+ 1
            accountsRegistryGenerations[locationID] = generation
            accountsRegistryLoadStates[locationID] = .loading
            error = await performAccountsRegistryHydration(
                at: locationID, client: requestClient, generation: generation)
            guard accountsRegistryLoadTokens[locationID] == token else { return error }
            if accountsRegistryGenerations[locationID] == generation {
                accountsRegistryLoadStates[locationID] =
                    error.map(ProjectionLoadState.failed) ?? .loaded
            }
        } while accountsRegistryTrailingHydrations.contains(locationID)

        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)
        accountsRegistryTrailingHydrations.remove(locationID)
        return error
    }

    private func performAccountsRegistryHydration(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        generation: UInt64
    ) async -> String? {
        do {
            let response = try await requestClient.credentialProfiles()
            guard accountsRegistryGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID)
            else { return nil }
            storeCredentialProfiles(
                response.profiles, accountPools: response.accountPools,
                at: locationID)
            // Plain responses contain an unfenced next_up. Keep its stable row
            // fields, but never authorize routing from it.
            accountsNextUpAuthorityFresh[locationID] = false
            accountsReadinessAuthorityFresh[locationID] = true
            if quotaResponse(at: locationID) == nil,
               hasAccountsQuotaSubscribers(at: locationID)
            {
                scheduleAccountsQuotaDisplayHydration(at: locationID)
            }
            return nil
        } catch {
            guard accountsRegistryGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID)
            else { return nil }
            return userMessage(for: error)
        }
    }
}
