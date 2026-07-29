import Foundation
import ClaudexorKit

private struct AccountsRefreshReceipt {
    let generation: UInt64
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

    /// Registered credential profiles + doctor readiness (INV-135). Drives the
    /// accounts popover; a failing fetch leaves the last snapshot in place.
    func refreshCredentialProfiles(locationID: ExecutionLocationID? = nil) async {
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
        let locationID = requestedLocationID ?? activeExecutionLocation
        let receipt = await loadCredentialProfilesReceipt(
            at: locationID, discardOnFailure: discardOnFailure)
        settleAccountsLoad(receipt, at: locationID)
        return receipt.error
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
        let receipt = await loadCredentialProfilesReceipt(
            at: locationID, discardOnFailure: false)
        settleAccountsLoad(receipt, at: locationID)
        guard receipt.error == nil,
              accountsRefreshGenerations[locationID] == receipt.generation
        else { return nil }
        let profiles = locationID == .local
            ? credentialProfiles
            : (remoteCredentialProfiles[locationID] ?? [])
        return profiles.first {
            $0.profile.harnessId == harnessID && $0.profile.profileId == profileID
        }
    }

    /// The request receipt keeps the data-generation fence and the Accounts
    /// presentation settlement on one authority. In particular, a newer
    /// background refresh that supersedes an in-flight foreground Retry owns
    /// the visible success/failure once it settles.
    private func loadCredentialProfilesReceipt(
        at locationID: ExecutionLocationID,
        discardOnFailure: Bool
    ) async -> AccountsRefreshReceipt {
        let previousQuotaCursor = suspendAccountsQuotaObserver(at: locationID)
        accountsNextUpAuthorityFresh[locationID] = false
        let generation = (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        accountsRefreshGenerations[locationID] = generation
        let finish: (String?) -> AccountsRefreshReceipt = {
            AccountsRefreshReceipt(generation: generation, error: $0)
        }
        guard let requestClient = gateway(for: locationID) else {
            if discardOnFailure,
               accountsRefreshGenerations[locationID] == generation,
               gateway(for: locationID) == nil
            {
                discardCompleteAccountsSnapshot(at: locationID)
            }
            return finish("Engine offline — reconnect to load accounts.")
        }
        guard let harnessLease = claimHarnessProjection(
            at: locationID, client: requestClient)
        else {
            return finish(
                "The engine connection changed before Accounts could refresh. Retry Accounts.")
        }
        do {
            let response = try await requestClient.credentialProfilesSnapshot()
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(accountsRefreshRetirementMessage(requestClient, at: locationID))
            }
            if let harnesses = response.harnesses,
               let git = response.git,
               let quota = response.quota,
               let quotaEventCursor = response.quotaEventCursor?.trimmingCharacters(
                   in: .whitespacesAndNewlines),
               !quotaEventCursor.isEmpty
            {
                guard acceptHarnessSnapshot(
                    harnesses, git: git, lease: harnessLease)
                else {
                    return finish(settleAccountsAfterSupersededHarnessProjection(
                        at: locationID,
                        client: requestClient,
                        previousQuotaCursor: previousQuotaCursor,
                        discardOnFailure: discardOnFailure))
                }
                storeCredentialProfiles(
                    response.profiles, harnessAccounts: response.harnessAccounts,
                    at: locationID)
                storeAccountsQuotaSnapshot(quota, at: locationID)
                startAccountsQuotaObserver(
                    at: locationID, client: requestClient, after: quotaEventCursor)
                // Reassert only after the complete profiles + harness + Git +
                // quota + cursor tuple has committed without an intervening await.
                accountsNextUpAuthorityFresh[locationID] = true
                return finish(nil)
            }
            // A daemon that ignored/omitted the complete opt-in response cannot
            // prove that next_up, harness rows, and quota share one epoch. Keep
            // profile readiness, drop that informational authority and quota,
            // and fetch one fresh harness list for honest compatibility.
            let fallbackRefreshed = await refreshHarnesses(
                fresh: true,
                locationID: locationID,
                markStaleOnFailure: discardOnFailure)
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(accountsRefreshRetirementMessage(requestClient, at: locationID))
            }
            storeCredentialProfiles(response.profiles, harnessAccounts: [], at: locationID)
            discardAccountsQuotaSnapshot(at: locationID)
            accountsNextUpAuthorityFresh[locationID] = false
            suspendAccountsQuotaObserver(at: locationID, discardCursor: true)
            if fallbackRefreshed {
                return finish(nil)
            }
            return finish("Could not refresh account readiness. Retry Accounts.")
        } catch {
            // Background callers keep the last snapshot. Accounts' explicit
            // fresh cycle discards it: stale profile readiness/next_up cannot
            // remain presented as current after the authoritative fetch failed.
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(accountsRefreshRetirementMessage(requestClient, at: locationID))
            }
            guard harnessProjectionIsCurrent(harnessLease) else {
                return finish(settleAccountsAfterSupersededHarnessProjection(
                    at: locationID,
                    client: requestClient,
                    previousQuotaCursor: previousQuotaCursor,
                    discardOnFailure: discardOnFailure))
            }
            if discardOnFailure { discardCompleteAccountsSnapshot(at: locationID) }
            else if let previousQuotaCursor {
                startAccountsQuotaObserver(
                    at: locationID, client: requestClient, after: previousQuotaCursor)
            }
            return finish(userMessage(for: error))
        }
    }

    private func accountsRefreshIsCurrent(
        _ generation: UInt64,
        client requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> Bool {
        accountsRefreshGenerations[locationID] == generation
            && gateway(for: locationID) === requestClient
    }

    /// Settle only the newest request generation. A background refresh may
    /// inherit an in-flight foreground token: once it supersedes that request,
    /// its receipt is the only request allowed to publish loaded or failed.
    private func settleAccountsLoad(
        _ receipt: AccountsRefreshReceipt,
        at locationID: ExecutionLocationID,
        foregroundToken: UUID? = nil
    ) {
        guard accountsRefreshGenerations[locationID] == receipt.generation else { return }
        if let foregroundToken {
            guard accountsLoadTokens[locationID] == foregroundToken else { return }
        }
        if accountsLoadTokens[locationID] != nil {
            accountsLoadTokens.removeValue(forKey: locationID)
            accountsLoadStates[locationID] =
                receipt.error.map(ProjectionLoadState.failed) ?? .loaded
        } else if receipt.error == nil {
            accountsLoadStates[locationID] = .loaded
        }
    }

    /// A newer Accounts refresh supersedes an older one silently. Retiring the
    /// exact daemon client is different: an explicit foreground refresh must
    /// not report that an empty, discarded projection loaded successfully.
    private func accountsRefreshRetirementMessage(
        _ requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> String? {
        isCurrentGateway(requestClient, at: locationID)
            ? nil
            : "The engine connection changed while Accounts was refreshing. Retry Accounts."
    }

    private func storeCredentialProfiles(
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

    private func discardCredentialProfiles(at locationID: ExecutionLocationID) {
        if locationID == .local {
            credentialProfiles = []
            harnessAccounts = []
        } else {
            remoteCredentialProfiles[locationID] = []
            remoteHarnessAccounts[locationID] = []
        }
    }

    func storeAccountsQuotaSnapshot(
        _ response: ControlQuotaResponse, at locationID: ExecutionLocationID
    ) {
        if locationID == .local { quotaResponse = response }
        else { remoteQuotaResponses[locationID] = response }
        quotaStatus = nil
    }

    private func discardAccountsQuotaSnapshot(at locationID: ExecutionLocationID) {
        if locationID == .local { quotaResponse = nil }
        else { remoteQuotaResponses.removeValue(forKey: locationID) }
    }

    private func discardAccountsOwnedSnapshot(at locationID: ExecutionLocationID) {
        discardCredentialProfiles(at: locationID)
        discardAccountsQuotaSnapshot(at: locationID)
        accountsNextUpAuthorityFresh[locationID] = false
        suspendAccountsQuotaObserver(at: locationID, discardCursor: true)
    }

    private func discardCompleteAccountsSnapshot(at locationID: ExecutionLocationID) {
        discardAccountsOwnedSnapshot(at: locationID)
        if locationID == .local {
            harnessReadinessFresh = false
            gitCapability = nil
        } else {
            remoteHarnessReadinessFresh[locationID] = false
            remoteGitCapabilities.removeValue(forKey: locationID)
        }
    }

    /// A newer harness projection ticket superseded Accounts while it awaited
    /// its tuple. Settle only Accounts-owned slices; the newer harness/Git owner
    /// must remain untouched.
    private func settleAccountsAfterSupersededHarnessProjection(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        previousQuotaCursor: String?,
        discardOnFailure: Bool
    ) -> String {
        accountsNextUpAuthorityFresh[locationID] = false
        if discardOnFailure {
            discardAccountsOwnedSnapshot(at: locationID)
        } else if let previousQuotaCursor,
                  isCurrentGateway(requestClient, at: locationID)
        {
            startAccountsQuotaObserver(
                at: locationID, client: requestClient, after: previousQuotaCursor)
        }
        return "A newer harness refresh superseded Accounts. Retry Accounts."
    }

    /// One event-driven Accounts refresh, pinned to one execution location for
    /// the whole await: fresh doctor readiness, account projection, Git, and
    /// quota arrive from one server-authored snapshot epoch.
    @discardableResult
    func refreshAccounts(locationID requestedLocationID: ExecutionLocationID? = nil) async
        -> String?
    {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let token = UUID()
        accountsLoadTokens[locationID] = token
        accountsLoadStates[locationID] = .loading
        let receipt = await loadCredentialProfilesReceipt(
            at: locationID, discardOnFailure: true)
        settleAccountsLoad(receipt, at: locationID, foregroundToken: token)
        return receipt.error
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
        autoBalanceOverride = on
        defer { autoBalanceOverride = nil }
        _ = await saveSettings(SettingsUpdateRequest(harnesses: patch))
    }
}
