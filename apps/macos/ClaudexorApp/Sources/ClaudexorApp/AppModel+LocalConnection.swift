import Foundation
import ClaudexorKit

// MARK: - Local engine connection and exact runtime coherence

extension AppModel {
    func connect() async {
        connectionGeneration += 1
        let generation = connectionGeneration
        // Retire the previous exact client synchronously, before the new
        // generation's first suspension. Every projection owner can now reject
        // an old response by client identity even while discovery/handshake for
        // the successor is still in flight.
        client = nil
        endpoint = ""
        engineIdentity = nil
        health = .connecting
        cancelAllStreams()
        let recovery = LocalConnectionRecoveryLoop(
            generation: generation,
            currentGeneration: { self.connectionGeneration },
            lifecycleOwner: localRuntimeLifecycleOwner,
            prepareProbe: {
                self.health = .connecting
                self.cancelAllStreams()
            },
            probe: { await self.tryConnect(generation: generation) },
            pollConnected: {
                guard self.client != nil else { return .unavailable }
                return await self.pollLocalConnection(generation: generation)
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
        for engine: EngineBuildIdentity?,
        generation: Int? = nil
    ) async -> LocalDaemonReconciliationPolicy {
        let serving = engine.flatMap {
            AppRuntimeDaemonControl.runtimeIdentity(version: $0.version, buildSha: $0.sha)
        }
        let result = await daemonReconciliationOwner().reconcile(
            serving: serving,
            isCurrent: { @MainActor [weak self] in
                guard let generation else { return true }
                guard let self else { return false }
                return !Task.isCancelled && self.connectionGeneration == generation
            })
        if let generation, !localConnectionGenerationIsCurrent(generation) {
            return .superseded
        }
        return LocalDaemonReconciliationPolicy(result)
    }

    private func tryConnect(generation: Int) async -> LocalConnectionProbeResult {
        do {
            let discovery = try ControlApiDiscovery.load()
            let candidate = try discovery.makeClient()
            return await tryConnect(
                candidate: candidate,
                endpoint: "\(discovery.host):\(discovery.port)",
                generation: generation)
        } catch {
            return localConnectionGenerationIsCurrent(generation)
                ? .unavailable : .superseded
        }
    }

    /// Injected candidate seam for deterministic connection-generation tests.
    /// Discovery and candidate construction remain side-effect-free; this method
    /// owns the first handshake and the single generation-bound adoption point.
    func tryConnect(
        candidate: GatewayClient,
        endpoint candidateEndpoint: String,
        generation: Int
    ) async -> LocalConnectionProbeResult {
        do {
            // One handshake serves both the connectivity verdict AND the engine
            // build identity (QA-002): retain what the daemon discloses instead
            // of a bare Bool that drops version/sha on the floor.
            let outcome = try await candidate.handshake()
            guard localConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            if outcome.ok {
                switch await localDaemonPolicy(for: outcome.engine, generation: generation) {
                case let .useCompatible(notice):
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    endpoint = candidateEndpoint
                    adoptClientForReconnect(candidate)
                    setLocalDaemonReconciliationNotice(notice)
                    engineIdentity = outcome.engine
                    health = .connected
                    await refreshRuns()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshSettings()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshSecrets()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshThreads()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshProjects()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // The full Accounts snapshot is intentionally explicit-only.
                    // Connect hydrates the cached harness + registry owners.
                    _ = await refreshHarnesses()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // QA-065: resolve credential-profile DISPLAY NAMES on connect, not
                    // only when the accounts popover opens — otherwise the sessions
                    // footer shows raw profile ids by default until that popover loads.
                    await refreshCredentialProfiles()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // A popover may survive a transient reconnect. Its existing
                    // subscriber does not re-run onAppear, so resume exactly one
                    // cheap display read against the replacement gateway.
                    scheduleAccountsQuotaDisplayHydration(at: .local)
                    startGlobalStream()
                    return .connected
                case .reconnect:
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    setLocalDaemonReconciliationNotice(nil)
                    client = nil
                    endpoint = ""
                    engineIdentity = nil
                    health = .connecting
                    return .reconnect
                case let .failOffline(notice):
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    setLocalDaemonReconciliationNotice(notice)
                    client = nil
                    engineIdentity = nil
                    return .lifecycleFailed
                case .superseded:
                    return .superseded
                case .retry:
                    return .retryWithoutLaunch
                }
            }
        } catch {
            // fall through to caller (offline / auto-start path)
        }
        return localConnectionGenerationIsCurrent(generation) ? .unavailable : .superseded
    }

    /// One steady-state connectivity poll (round-4 #5 / QA-002): re-HANDSHAKE
    /// rather than the bare `health()` Bool, so a daemon SWAPPED at the same
    /// endpoint refreshes its disclosed build identity instead of pinning the old
    /// version/sha in About forever. A dropped or incompatible handshake returns
    /// false → the caller falls to the reconnect path.
    @discardableResult
    func pollEngineIdentity() async -> Bool {
        await pollLocalConnection() == .connected
    }

    /// Typed steady-state poll. The recovery loop must distinguish an ordinary
    /// transport loss (which earns one outage launch) from reconciliation that
    /// already launched, or attempted to launch, the selected closure.
    func pollLocalConnection(generation: Int? = nil) async -> LocalConnectionProbeResult {
        guard let current = client, let outcome = try? await current.handshake(), outcome.ok else {
            return requestedConnectionGenerationIsCurrent(generation)
                ? .unavailable : .superseded
        }
        guard requestedConnectionGenerationIsCurrent(generation) else {
            return .superseded
        }
        switch await localDaemonPolicy(for: outcome.engine, generation: generation) {
        case let .useCompatible(notice):
            guard requestedConnectionGenerationIsCurrent(generation), client === current else {
                return .superseded
            }
            setLocalDaemonReconciliationNotice(notice)
            engineIdentity = outcome.engine
            return .connected
        case .reconnect:
            guard requestedConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            // The old handshake and the replacement's internal proof are both
            // deliberately unpublished. The connect owner reacquires discovery,
            // handshakes again, then hydrates the new daemon as one coherent unit.
            setLocalDaemonReconciliationNotice(nil)
            client = nil
            endpoint = ""
            engineIdentity = nil
            health = .connecting
            cancelAllStreams()
            return .reconnect
        case let .failOffline(notice):
            guard requestedConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            setLocalDaemonReconciliationNotice(notice)
            client = nil
            engineIdentity = nil
            cancelAllStreams()
            return .lifecycleFailed
        case .superseded:
            return .superseded
        case .retry:
            return .retryWithoutLaunch
        }
    }

    private func localConnectionGenerationIsCurrent(_ generation: Int) -> Bool {
        !Task.isCancelled && connectionGeneration == generation
    }

    private func localConnectionLeaseIsCurrent(
        _ generation: Int,
        _ requestClient: GatewayClient
    ) -> Bool {
        localConnectionGenerationIsCurrent(generation) && client === requestClient
    }

    private func requestedConnectionGenerationIsCurrent(_ generation: Int?) -> Bool {
        guard let generation else { return !Task.isCancelled }
        return localConnectionGenerationIsCurrent(generation)
    }
}
