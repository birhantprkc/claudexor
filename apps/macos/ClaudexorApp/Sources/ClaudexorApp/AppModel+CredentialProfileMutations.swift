import ClaudexorKit

// MARK: - Credential profile mutations + quota rotation

extension AppModel {
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
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
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
        if ok {
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
        } else {
            await refreshCredentialProfiles(locationID: locationID)
        }
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
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
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
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
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
