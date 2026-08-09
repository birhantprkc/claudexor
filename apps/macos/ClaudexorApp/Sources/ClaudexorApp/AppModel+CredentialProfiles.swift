import Foundation
import ClaudexorKit

struct AccountsRefreshReceipt: Sendable {
    let generation: UInt64
    let registryGeneration: UInt64
    let profiles: [CredentialProfileEntry]?
    let registryCommitted: Bool
    let error: String?
}

// MARK: - Credential profiles + auto-balance (INV-135)
//
// The account-registry half of AppModel: registered credential profiles with
// doctor readiness, in-app registration/removal, and the auto-balance toggle
// (per-harness profile_policy.limit_action via the settings wire).

extension AppModel {
    var activeAccountsLoadState: ProjectionLoadState {
        accountsLoadStates[activeExecutionLocation] ?? .idle
    }

    var activeAccountsRegistryLoadState: ProjectionLoadState {
        accountsRegistryLoadStates[activeExecutionLocation]
            ?? (activeCredentialProfiles.isEmpty ? .idle : .loaded)
    }

    var activeAccountsReadinessFresh: Bool {
        accountsReadinessAuthorityFresh[activeExecutionLocation] != false
    }

    /// Persist the thread's manual account choice (INV-135). nil restores the
    /// engine-default ladder; a draft carries the choice into thread creation.
    func setThreadCredentialProfile(_ profileId: String?, harnessId: String? = nil) async {
        guard let id = selectedThreadId else {
            draftCredentialProfileId = profileId
            if let harnessId {
                draftPrimaryHarness = harnessId
                if profileId != nil { draftEligiblePool = [harnessId] }
            }
            return
        }
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change the account."
            return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id,
                body: UpdateThreadRequest(
                    primaryHarness: harnessId.map { .some($0) },
                    eligibleHarnesses: profileId == nil ? nil : harnessId.map { [$0] },
                    credentialProfileId: .some(profileId)))
            applyThreadUpdate(updated, at: locationID)
        } catch {
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                threadStatus = userMessage(for: error)
            }
        }
    }

    /// Cached registry hydration (INV-135). Opening Accounts, connect, and
    /// mutations use this lighter endpoint; it never performs the expensive
    /// quota/provider snapshot and never claims atomic `next_up` authority.
    func refreshCredentialProfiles(locationID: ExecutionLocationID? = nil) async {
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
    ) async
        -> String?
    {
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
        accountsNextUpAuthorityFresh[locationID] = false
        let generation = (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        accountsRegistryGenerations[locationID] = generation
        let token = UUID()
        accountsRegistryLoadTokens[locationID] = token
        accountsRegistryLoadStates[locationID] = .loading
        let task: Task<String?, Never> = Task { @MainActor [weak self] in
            guard let self else { return Optional("Accounts stopped loading.") }
            return await self.performAccountsRegistryHydration(
                at: locationID,
                client: requestClient,
                generation: generation)
        }
        accountsRegistryLoadTasks[locationID] = task
        let error = await task.value
        guard accountsRegistryLoadTokens[locationID] == token else { return error }
        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)
        if accountsRegistryGenerations[locationID] == generation {
            accountsRegistryLoadStates[locationID] =
                error.map(ProjectionLoadState.failed) ?? .loaded
        }
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
                response.profiles, harnessAccounts: response.harnessAccounts,
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

    /// Fetch and return one exact account only when this request remains the
    /// current projection owner through commit. The ordinary Accounts loader
    /// intentionally retires an older caller silently when a newer refresh
    /// supersedes it; setup verification must not mistake that nil error for a
    /// fresh receipt and read the previous shared projection.
    func refreshExactCredentialProfile(
        harnessID: String,
        profileID: String,
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> CredentialProfileEntry? {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let receipt = await refreshAccountsReceipt(at: locationID)
        guard receipt.error == nil,
              receipt.registryCommitted,
              accountsRefreshGenerations[locationID] == receipt.generation,
              accountsRegistryGenerations[locationID] == receipt.registryGeneration
        else { return nil }
        return receipt.profiles?.first {
            $0.profile.harnessId == harnessID && $0.profile.profileId == profileID
        }
    }

    /// The request receipt keeps the data-generation fence and the Accounts
    /// presentation settlement on one authority. In particular, a newer
    /// background refresh that supersedes an in-flight foreground Retry owns
    /// the visible success/failure once it settles.
    private func performAccountsRefresh(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        harnessLease: HarnessProjectionLease,
        generation: UInt64,
        registryGeneration: UInt64,
        quotaDisplayGenerationAtStart: UInt64,
        previousQuotaCursor: String?
    ) async -> AccountsRefreshReceipt {
        let finish: ([CredentialProfileEntry]?, Bool, String?) -> AccountsRefreshReceipt = {
            AccountsRefreshReceipt(
                generation: generation,
                registryGeneration: registryGeneration,
                profiles: $0,
                registryCommitted: $1,
                error: $2)
        }
        do {
            let response = try await requestClient.credentialProfilesSnapshot()
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(nil, false, accountsRefreshRetirementMessage(
                    requestClient, at: locationID))
            }
            if let harnesses = response.harnesses,
               let git = response.git,
               let quota = response.quota,
               let quotaEventCursor = response.quotaEventCursor?.trimmingCharacters(
                   in: .whitespacesAndNewlines),
               !quotaEventCursor.isEmpty
            {
                let registryCommitted = commitAccountsRegistryIfCurrent(
                    response, at: locationID, generation: registryGeneration)
                guard acceptHarnessSnapshot(
                    harnesses, git: git, lease: harnessLease)
                else {
                    let message = settleAccountsAfterSupersededHarnessProjection(
                        at: locationID,
                        client: requestClient,
                        registryGeneration: registryGeneration,
                        previousQuotaCursor: previousQuotaCursor,
                        quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                        markHarnessReadinessStale: false)
                    return finish(response.profiles, registryCommitted, message)
                }
                storeAccountsQuotaSnapshot(quota, at: locationID)
                rememberAccountsQuotaDisplayMarker(quotaEventCursor, at: locationID)
                startAccountsQuotaObserver(
                    at: locationID, client: requestClient, after: quotaEventCursor)
                accountsReadinessAuthorityFresh[locationID] = true
                // A later plain hydration/mutation owns the stable registry and
                // intentionally expires the tuple's next_up authority.
                accountsNextUpAuthorityFresh[locationID] = registryCommitted
                if registryCommitted {
                    accountsRegistryLoadStates[locationID] = .loaded
                    return finish(response.profiles, true, nil)
                }
                return finish(
                    response.profiles,
                    false,
                    "Accounts changed while the full refresh was running. Refresh again for routing order.")
            }
            let registryCommitted = commitAccountsProfilesOnlyIfCurrent(
                response.profiles, at: locationID, generation: registryGeneration)
            if registryCommitted {
                accountsRegistryLoadStates[locationID] = .loaded
            }
            let message = "The engine returned an incomplete Accounts snapshot. Update the runtime and retry."
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            return finish(response.profiles, registryCommitted, message)
        } catch {
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(nil, false, accountsRefreshRetirementMessage(
                    requestClient, at: locationID))
            }
            guard harnessProjectionIsCurrent(harnessLease) else {
                let message = settleAccountsAfterSupersededHarnessProjection(
                    at: locationID,
                    client: requestClient,
                    registryGeneration: registryGeneration,
                    previousQuotaCursor: previousQuotaCursor,
                    quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                    markHarnessReadinessStale: false)
                return finish(nil, false, message)
            }
            let message = userMessage(for: error)
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            return finish(nil, false, message)
        }
    }

    private func commitAccountsRegistryIfCurrent(
        _ response: CredentialProfilesResponse,
        at locationID: ExecutionLocationID,
        generation: UInt64
    ) -> Bool {
        guard accountsRegistryGenerations[locationID] == generation else { return false }
        storeCredentialProfiles(
            response.profiles,
            harnessAccounts: response.harnessAccounts,
            at: locationID)
        return true
    }

    /// A legacy/incomplete response cannot authoritatively replace the native
    /// HarnessAccounts slice (older daemons omit it and decode as empty). Its
    /// profile registry remains useful, so update that slice without erasing the
    /// last stable native identities/Enabled values.
    private func commitAccountsProfilesOnlyIfCurrent(
        _ profiles: [CredentialProfileEntry],
        at locationID: ExecutionLocationID,
        generation: UInt64
    ) -> Bool {
        guard accountsRegistryGenerations[locationID] == generation else { return false }
        if locationID == .local { credentialProfiles = profiles }
        else { remoteCredentialProfiles[locationID] = profiles }
        return true
    }

    private func accountsRefreshIsCurrent(
        _ generation: UInt64,
        client requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> Bool {
        accountsRefreshGenerations[locationID] == generation
            && gateway(for: locationID) === requestClient
    }

    /// A newer Accounts refresh supersedes an older one silently. Retiring the
    /// exact daemon client is different: an explicit foreground refresh must
    /// not report that an empty, discarded projection loaded successfully.
    private func accountsRefreshRetirementMessage(
        _ requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> String? {
        isCurrentGateway(requestClient, at: locationID)
            ? "A newer Accounts owner superseded this refresh. Retry Accounts."
            : "The engine connection changed while Accounts was refreshing. Retry Accounts."
    }

    func storeCredentialProfiles(
        _ profiles: [CredentialProfileEntry],
        harnessAccounts accounts: [HarnessAccounts],
        at locationID: ExecutionLocationID
    ) {
        if locationID == .local {
            credentialProfiles = profiles
            harnessAccounts = accounts
        } else {
            remoteCredentialProfiles[locationID] = profiles
            remoteHarnessAccounts[locationID] = accounts
        }
    }

    /// A newer harness projection ticket superseded Accounts while it awaited
    /// its tuple. Settle only Accounts-owned slices; the newer harness/Git owner
    /// must remain untouched.
    private func settleAccountsAfterSupersededHarnessProjection(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        registryGeneration: UInt64,
        previousQuotaCursor: String?,
        quotaDisplayGenerationAtStart: UInt64,
        markHarnessReadinessStale: Bool
    ) -> String {
        let message = "A newer harness refresh superseded Accounts. Retry Accounts."
        markAccountsRefreshFailure(
            at: locationID,
            client: requestClient,
            registryGeneration: registryGeneration,
            previousQuotaCursor: previousQuotaCursor,
            quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
            reason: message,
            markHarnessReadinessStale: markHarnessReadinessStale)
        return message
    }

    private func markAccountsRefreshFailure(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient?,
        registryGeneration: UInt64,
        previousQuotaCursor: String?,
        quotaDisplayGenerationAtStart: UInt64,
        reason: String,
        markHarnessReadinessStale: Bool = true
    ) {
        accountsNextUpAuthorityFresh[locationID] = false
        // A plain hydration admitted after this full refresh owns newer
        // profile/native-account readiness and must not be downgraded by the
        // older failure settling late.
        if (accountsRegistryGenerations[locationID] ?? 0) == registryGeneration {
            accountsReadinessAuthorityFresh[locationID] = false
        }
        if markHarnessReadinessStale {
            if locationID == .local { harnessReadinessFresh = false }
            else { remoteHarnessReadinessFresh[locationID] = false }
        }
        let registryState = accountsRegistryLoadStates[locationID]
        if (accountsRegistryGenerations[locationID] ?? 0) == registryGeneration,
           registryState == nil || registryState == .idle || registryState == .loading
        {
            accountsRegistryLoadStates[locationID] = .failed(reason)
        }
        // A display-only GET that STARTED after this full refresh owns newer
        // display data; do not downgrade it when the older full request fails.
        if (accountsQuotaDisplayGenerations[locationID] ?? 0) == quotaDisplayGenerationAtStart {
            markAccountsQuotaDisplayStale(at: locationID, reason: reason)
        }
        if let previousQuotaCursor,
           let requestClient,
           isCurrentGateway(requestClient, at: locationID)
        {
            startAccountsQuotaObserver(
                at: locationID, client: requestClient, after: previousQuotaCursor)
        }
    }

    /// One event-driven Accounts refresh, pinned to one execution location for
    /// the whole await: fresh doctor readiness, account projection, Git, and
    /// quota arrive from one server-authored snapshot epoch.
    @discardableResult
    func refreshAccounts(locationID requestedLocationID: ExecutionLocationID? = nil) async
        -> String?
    {
        let locationID = requestedLocationID ?? activeExecutionLocation
        return await refreshAccountsReceipt(at: locationID).error
    }

    private func refreshAccountsReceipt(at locationID: ExecutionLocationID) async
        -> AccountsRefreshReceipt
    {
        if let inFlight = accountsRefreshTasks[locationID] {
            return await inFlight.value
        }
        guard let requestClient = gateway(for: locationID) else {
            let message = "Engine offline — reconnect to refresh Accounts."
            let registryGeneration = accountsRegistryGenerations[locationID] ?? 0
            markAccountsRefreshFailure(
                at: locationID,
                client: nil,
                registryGeneration: registryGeneration,
                previousQuotaCursor: nil,
                quotaDisplayGenerationAtStart: accountsQuotaDisplayGenerations[locationID] ?? 0,
                reason: message)
            accountsLoadStates[locationID] = .failed(message)
            return AccountsRefreshReceipt(
                generation: accountsRefreshGenerations[locationID] ?? 0,
                registryGeneration: registryGeneration,
                profiles: nil,
                registryCommitted: false,
                error: message)
        }

        // A full refresh retires an older cached hydration. Its late response is
        // fenced by registryGeneration even if URL loading ignores cancellation.
        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)?.cancel()
        let registryGeneration = (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        accountsRegistryGenerations[locationID] = registryGeneration
        let generation = (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        accountsRefreshGenerations[locationID] = generation
        let quotaDisplayGenerationAtStart = accountsQuotaDisplayGenerations[locationID] ?? 0
        let previousQuotaCursor = suspendAccountsQuotaObserver(at: locationID)
        accountsNextUpAuthorityFresh[locationID] = false
        if accountsRegistryLoadStates[locationID] == nil {
            accountsRegistryLoadStates[locationID] = .loading
        }
        guard let harnessLease = claimHarnessProjection(
            at: locationID, client: requestClient)
        else {
            let message = "The engine connection changed before Accounts could refresh. Retry Accounts."
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            accountsLoadStates[locationID] = .failed(message)
            return AccountsRefreshReceipt(
                generation: generation,
                registryGeneration: registryGeneration,
                profiles: nil,
                registryCommitted: false,
                error: message)
        }

        let token = UUID()
        accountsRefreshTaskTokens[locationID] = token
        accountsLoadTokens[locationID] = token
        accountsLoadStates[locationID] = .loading
        let task = Task { @MainActor [weak self] in
            guard let self else {
                return AccountsRefreshReceipt(
                    generation: generation,
                    registryGeneration: registryGeneration,
                    profiles: nil,
                    registryCommitted: false,
                    error: "Accounts stopped refreshing.")
            }
            return await self.performAccountsRefresh(
                at: locationID,
                client: requestClient,
                harnessLease: harnessLease,
                generation: generation,
                registryGeneration: registryGeneration,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                previousQuotaCursor: previousQuotaCursor)
        }
        accountsRefreshTasks[locationID] = task
        let receipt = await task.value
        guard accountsRefreshTaskTokens[locationID] == token else { return receipt }
        accountsRefreshTaskTokens.removeValue(forKey: locationID)
        accountsRefreshTasks.removeValue(forKey: locationID)
        accountsLoadTokens.removeValue(forKey: locationID)
        if accountsRefreshGenerations[locationID] == generation {
            accountsLoadStates[locationID] =
                receipt.error.map(ProjectionLoadState.failed) ?? .loaded
        }
        return receipt
    }

    func retireAccountsRequests(at locationID: ExecutionLocationID) {
        accountsReadinessAuthorityFresh[locationID] = false
        accountsNextUpAuthorityFresh[locationID] = false
        accountsRegistryGenerations[locationID] =
            (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)?.cancel()
        accountsRefreshGenerations[locationID] =
            (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        accountsRefreshTaskTokens.removeValue(forKey: locationID)
        accountsRefreshTasks.removeValue(forKey: locationID)?.cancel()
        accountsLoadTokens.removeValue(forKey: locationID)
        // A connection boundary cannot leave either independent UI lane in an
        // orphaned spinner after its task/token has been retired. Stable loaded
        // or failed states remain until their owner explicitly replaces them.
        if accountsRegistryLoadStates[locationID] == .loading {
            accountsRegistryLoadStates[locationID] = .idle
        }
        if accountsLoadStates[locationID] == .loading {
            accountsLoadStates[locationID] = .idle
        }
    }

    /// The V11b per-harness accounts authority for `harnessId` (native CLI-login
    /// state + the server-computed informational next-up identity), or nil when
    /// the projection is absent (pre-V11b daemon) — callers then fall back to
    /// client-derived state.
    func harnessAccounts(for harnessId: String) -> HarnessAccounts? {
        activeHarnessAccounts.first { $0.harnessId == harnessId }
    }

    /// The next-up identity is a separately expiring slice of HarnessAccounts.
    /// Invalidating it never fabricates `.none` and never erases Enabled or identity.
    func authoritativeNextUp(for harnessId: String) -> ControlNextUpIdentity? {
        guard accountsNextUpAuthorityFresh[activeExecutionLocation] == true else { return nil }
        return harnessAccounts(for: harnessId)?.nextUp
    }

    /// Toggle a credential profile's Enabled (V11b — the Enabled row of the
    /// accounts symmetry). PATCHes the profile route, then reloads the projection
    /// so Enabled/Active reflect wire truth. Returns a refusal string on failure.
    @discardableResult
    func setProfileEnabled(harnessId: String, profileId: String, enabled: Bool) async -> String? {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return "Engine offline — reconnect to change the account."
        }
        do {
            _ = try await requestClient.updateCredentialProfile(
                harnessId: harnessId, profileId: profileId, enabled: enabled)
            await refreshCredentialProfiles(locationID: locationID)
            return nil
        } catch {
            await refreshCredentialProfiles(locationID: locationID)
            return userMessage(for: error)
        }
    }

    /// Toggle the native/CLI login's participation in a harness's credential
    /// ladder (V11b — the CLI-login row's Enabled). Drives the per-harness
    /// `native_credentials_enabled` via the settings PATCH surface; the save
    /// answer IS the fresh snapshot (applied inside saveSettings, #20/D1), so
    /// only the accounts projection reloads here. Returns nil on success.
    @discardableResult
    func setNativeCredentialsEnabled(harnessId: String, enabled: Bool) async -> String? {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        let ok = await saveSettings(SettingsUpdateRequest(
            harnesses: [harnessId: HarnessSettingsPatch(nativeCredentialsEnabled: enabled)]))
        await refreshCredentialProfiles(locationID: locationID)
        return ok ? nil : (settingsStatus ?? "Could not update the native login setting.")
    }

    /// Register a new credential profile (INV-135). On success the registry is
    /// refreshed and the new entry returned so the accounts popover can offer its
    /// login immediately. On failure the daemon's reason (409 duplicate id / 400
    /// invalid slug or harness) is returned verbatim for inline display.
    func createCredentialProfile(harnessId: String, profileId: String, displayName: String?) async
        -> (entry: CredentialProfileEntry?, error: String?) {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return (nil, "Engine offline — reconnect to add an account.")
        }
        do {
            let entry = try await requestClient.createCredentialProfile(
                CreateCredentialProfileRequest(harnessId: harnessId, profileId: profileId, displayName: displayName))
            await refreshCredentialProfiles(locationID: locationID)
            return (entry, nil)
        } catch {
            return (nil, userMessage(for: error))
        }
    }

    /// Remove a credential profile (INV-135): the daemon deletes the registry
    /// entry plus the profile's own credential material (scoped login dir /
    /// namespaced secret; the default vendor store is untouchable). Returns the
    /// daemon's reason on refusal (409 while a login job is active) and any
    /// cleanup warning verbatim for inline display.
    func deleteCredentialProfile(harnessId: String, profileId: String) async -> String? {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return "Engine offline — reconnect to remove an account."
        }
        do {
            let receipt = try await requestClient.deleteCredentialProfile(
                harnessId: harnessId, profileId: profileId)
            if draftCredentialProfileId == profileId {
                draftCredentialProfileId = nil
                if draftPrimaryHarness == harnessId { draftPrimaryHarness = nil }
            }
            await refreshCredentialProfiles(locationID: locationID)
            if locationID == .local {
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
            }
            if let selectedThreadId {
                await refreshOpenThread(
                    locationID: locationID, id: selectedThreadId, mayReconnect: false)
            }
            return receipt.cleanupWarning
        } catch {
            return userMessage(for: error)
        }
    }


    // MARK: Auto-switch-at-quota (batch-6 item b)

    /// The harnesses the auto-switch toggle targets: config_dir_login families
    /// with a SECOND account registered (native login + ≥1 profile = 2+ rotatable
    /// identities). A single-account harness cannot rotate, so it is excluded —
    /// the old hardcoded [claude, codex] set patched harnesses that had nothing to
    /// switch to (owner: "renders but doesn't activate").
    var autoBalanceHarnessIds: [String] {
        AccountsAutoBalance.eligibleHarnessIds(
            profileHarnessIds: activeCredentialProfiles.map(\.profile.harnessId))
    }

    /// Aggregated auto-switch state across the eligible harnesses. `mixed` (they
    /// disagree) renders as "—"; `unavailable` (no 2nd account anywhere) disables
    /// the toggle. Reads the per-harness `profile_limit_action` from settings.
    var autoBalanceState: AccountsAutoBalance.State {
        if let pending = autoBalanceOverride {
            // While a save round-trips, reflect the optimistic choice — but only
            // when there is actually an eligible harness to have set.
            return autoBalanceHarnessIds.isEmpty ? .unavailable : (pending ? .on : .off)
        }
        let actions = autoBalanceHarnessIds.map {
            activeSettingsSnapshot?.harnesses?[$0]?.profileLimitAction ?? "fail"
        }
        return AccountsAutoBalance.state(actions: actions)
    }

    /// Flip auto-switch for every eligible harness at once (on = rotate, off =
    /// fail), so a mixed state resolves to a single consistent choice.
    func setAutoBalance(_ on: Bool) async {
        // ON sets rotate on every eligible harness. OFF only downgrades harnesses
        // currently on "rotate" — a hand-configured "ask" is not auto-switch, so
        // the toggle must not erase it.
        let patch = Dictionary(uniqueKeysWithValues: autoBalanceHarnessIds.compactMap {
            id -> (String, HarnessSettingsPatch)? in
            let current = activeSettingsSnapshot?.harnesses?[id]?.profileLimitAction ?? "fail"
            if on { return current == "rotate" ? nil : (id, HarnessSettingsPatch(profileLimitAction: "rotate")) }
            return current == "rotate" ? (id, HarnessSettingsPatch(profileLimitAction: "fail")) : nil
        })
        guard !patch.isEmpty else { return }
        accountsNextUpAuthorityFresh[activeExecutionLocation] = false
        autoBalanceOverride = on
        defer { autoBalanceOverride = nil }
        _ = await saveSettings(SettingsUpdateRequest(harnesses: patch))
    }
}
