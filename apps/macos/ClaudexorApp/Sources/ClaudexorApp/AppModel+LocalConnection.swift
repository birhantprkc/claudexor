import Foundation
import ClaudexorKit

// MARK: - Local engine connection and exact runtime coherence

extension AppModel {
    func connect() async {
        connectionGeneration += 1
        let generation = connectionGeneration
        let recovery = LocalConnectionRecoveryLoop(
            generation: generation,
            currentGeneration: { self.connectionGeneration },
            lifecycleOwner: localRuntimeLifecycleOwner,
            prepareProbe: {
                self.health = .connecting
                self.cancelAllStreams()
            },
            probe: { await self.tryConnect() },
            pollConnected: {
                guard self.client != nil else { return false }
                return await self.pollEngineIdentity()
            },
            startDaemon: { DaemonLauncher.startIfNeeded() },
            enterOffline: { self.enterHardOffline() },
            pause: { try? await Task.sleep(for: .seconds(3)) })
        await recovery.run()
    }

    /// Drop every daemon-owned projection when the engine is unreachable. The
    /// reconnect path repopulates these from `/v2`; user preferences and the
    /// current composer draft remain local and are intentionally preserved.
    func enterHardOffline() {
        let keepRemoteSelection = activeExecutionLocation != .local
        health = .offline
        endpoint = ""
        client = nil
        engineIdentity = nil
        authSheetTarget = nil
        cancelAllStreams()
        // Retire queued settings ops (X20) but KEEP the chain tail (X30): a
        // post-reconnect op must still await the old in-flight request, or two
        // settings requests overlap on the wire and break the X14 single-chain
        // criterion. Old ops retire inert through their epoch guards.
        settingsEpoch += 1
        retireHarnessProjection(at: .local)

        if !keepRemoteSelection { route = .threads }
        liveTasks.removeAll()
        discardCancelledRunMemory(at: .local)
        transcripts.removeAll()
        liveBoxes.removeAll()
        retireRunDetailState(cancelInFlight: true)
        runListReconciliationNeeded = false
        if !keepRemoteSelection { turnSubmitting = false }

        threads.removeAll()
        projectListingProblems.removeAll()
        registeredProjects.removeAll()
        if !keepRemoteSelection {
            selectedThreadId = nil
            selectedThreadDetail = nil
            threadStatus = nil
            threadLoadGeneration += 1
        }

        liveHarnesses.removeAll()
        harnessReadinessFresh = nil
        gitCapability = nil
        retireRunApplicability(at: .local)
        // X140 class: the credential-profile + harness-account registries load on
        // connect and feed the sessions footer/accounts surfaces — leaving them
        // presents the last daemon's registry as truth. Reconnect repopulates.
        credentialProfiles.removeAll()
        harnessAccounts.removeAll()
        retireAccountsRequests(at: .local)
        accountsRegistryLoadStates.removeValue(forKey: .local)
        accountsLoadTokens.removeValue(forKey: .local)
        accountsLoadStates.removeValue(forKey: .local)
        accountsReadinessAuthorityFresh.removeValue(forKey: .local)
        accountsNextUpAuthorityFresh.removeValue(forKey: .local)
        suspendAccountsQuotaObserver(at: .local, discardCursor: true)
        exactAuthSources.removeAll()
        settingsSnapshot = nil
        settingsLoadTokens.removeValue(forKey: .local)
        settingsLoadStates.removeValue(forKey: .local)
        settingsStatus = nil
        retireAccountsQuotaDisplayRequest(at: .local, discardProjection: true)
        quotaStatus = nil
        secretBackend = "unknown"
        storedSecrets.removeAll()
        trustEntries.removeAll()
        trustStatus = nil
    }

    /// A daemon replacement cannot inherit a local cancel verdict for a reused
    /// run id. Keep cancellation memory scoped to the exact location epoch.
    func discardCancelledRunMemory(at locationID: ExecutionLocationID) {
        let prefix = "\(locationID.rawValue)|"
        cancelledRunIds = Set(cancelledRunIds.filter { !$0.hasPrefix(prefix) })
    }

    func rememberRunCancelled(_ id: String, at locationID: ExecutionLocationID) {
        cancelledRunIds.insert(locatedRunKey(id, at: locationID))
    }

    func wasRunCancelled(_ id: String, at locationID: ExecutionLocationID) -> Bool {
        cancelledRunIds.contains(locatedRunKey(id, at: locationID))
    }

    /// Retire every per-run detail owner at a connection boundary. Tests may
    /// leave the old task uncancelled to release its response after a new
    /// same-id request and prove the client/token fences deterministically.
    func retireRunDetailState(cancelInFlight: Bool) {
        snapshotLoadDepth.removeAll()
        snapshotReplayFences.removeAll()
        hydratedRunDetails.removeAll()
        if cancelInFlight {
            for task in runDetailLoads.values { task.cancel() }
        }
        runDetailLoads.removeAll()
        runDetailLoadTokens.removeAll()
        runDetailTrailing.removeAll()
        runDetailAcceptingTrailing.removeAll()
        deferredEnvelopes.removeAll()
        deferredOverflow.removeAll()
    }

    private func daemonReconciliationOwner() -> LocalDaemonReconciler {
        if let localDaemonReconciler { return localDaemonReconciler }
        let reconciler = LocalDaemonReconciler(
            daemon: makeDaemonControl(),
            lifecycleOwner: localRuntimeLifecycleOwner)
        localDaemonReconciler = reconciler
        return reconciler
    }

    /// Publish exact-closure coherence independently from update/install state.
    private func setLocalDaemonReconciliationNotice(_ notice: String?) {
        localDaemonReconciliationNotice = notice
    }

    /// Reconcile one compatible handshake against the exact selected local
    /// closure. Protocol compatibility remains the connection authority; an
    /// unstampable identity is deliberately passed as nil and reduced to a safe,
    /// visible keep-compatible policy before any lifecycle work.
    func localDaemonPolicy(
        for engine: EngineBuildIdentity?
    ) async -> LocalDaemonReconciliationPolicy {
        let serving = engine.flatMap {
            AppRuntimeDaemonControl.runtimeIdentity(version: $0.version, buildSha: $0.sha)
        }
        let result = await daemonReconciliationOwner().reconcile(serving: serving)
        return LocalDaemonReconciliationPolicy(result)
    }

    private func tryConnect() async -> LocalConnectionProbeResult {
        do {
            let discovery = try ControlApiDiscovery.load()
            let candidate = try discovery.makeClient()
            endpoint = "\(discovery.host):\(discovery.port)"
            adoptClientForReconnect(candidate)
            // One handshake serves both the connectivity verdict AND the engine
            // build identity (QA-002): retain what the daemon discloses instead
            // of a bare Bool that drops version/sha on the floor.
            let outcome = try await candidate.handshake()
            if outcome.ok {
                switch await localDaemonPolicy(for: outcome.engine) {
                case let .useCompatible(notice):
                    guard client === candidate else { return .unavailable }
                    setLocalDaemonReconciliationNotice(notice)
                    engineIdentity = outcome.engine
                    health = .connected
                    await refreshRuns()
                    await refreshSettings()
                    await refreshSecrets()
                    await refreshThreads()
                    await refreshProjects()
                    // The full Accounts snapshot is intentionally explicit-only.
                    // Connect hydrates the cached harness + registry owners.
                    _ = await refreshHarnesses()
                    // QA-065: resolve credential-profile DISPLAY NAMES on connect, not
                    // only when the accounts popover opens — otherwise the sessions
                    // footer shows raw profile ids by default until that popover loads.
                    await refreshCredentialProfiles()
                    // A popover may survive a transient reconnect. Its existing
                    // subscriber does not re-run onAppear, so resume exactly one
                    // cheap display read against the replacement gateway.
                    scheduleAccountsQuotaDisplayHydration(at: .local)
                    startGlobalStream()
                    return .connected
                case .reconnect:
                    setLocalDaemonReconciliationNotice(nil)
                    client = nil
                    endpoint = ""
                    engineIdentity = nil
                    health = .connecting
                    return .reconnect
                case let .failOffline(notice):
                    setLocalDaemonReconciliationNotice(notice)
                    client = nil
                    engineIdentity = nil
                    return .lifecycleFailed
                }
            }
        } catch {
            // fall through to caller (offline / auto-start path)
        }
        return .unavailable
    }

    /// One steady-state connectivity poll (round-4 #5 / QA-002): re-HANDSHAKE
    /// rather than the bare `health()` Bool, so a daemon SWAPPED at the same
    /// endpoint refreshes its disclosed build identity instead of pinning the old
    /// version/sha in About forever. A dropped or incompatible handshake returns
    /// false → the caller falls to the reconnect path.
    @discardableResult
    func pollEngineIdentity() async -> Bool {
        guard let current = client, let outcome = try? await current.handshake(), outcome.ok else {
            return false
        }
        switch await localDaemonPolicy(for: outcome.engine) {
        case let .useCompatible(notice):
            guard client === current else { return false }
            setLocalDaemonReconciliationNotice(notice)
            engineIdentity = outcome.engine
            return true
        case .reconnect:
            // The old handshake and the replacement's internal proof are both
            // deliberately unpublished. The connect owner reacquires discovery,
            // handshakes again, then hydrates the new daemon as one coherent unit.
            setLocalDaemonReconciliationNotice(nil)
            engineIdentity = nil
            return false
        case let .failOffline(notice):
            setLocalDaemonReconciliationNotice(notice)
            engineIdentity = nil
            return false
        }
    }
}
