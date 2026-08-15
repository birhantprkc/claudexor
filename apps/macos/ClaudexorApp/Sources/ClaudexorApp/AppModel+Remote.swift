import ClaudexorKit
import Foundation

extension AppModel {
    @discardableResult
    func connectRemote(_ id: UUID, allowInteraction: Bool = true) async -> GatewayClient? {
        await connectRemoteCore(
            id, allowInteraction: allowInteraction, transferredActivation: nil)
    }

    /// Manual installation transfers its exact pending activation into the
    /// reconnect generation. From this call onward the reconnect owns both
    /// commit and rollback, so no outer caller can publish a candidate first or
    /// race a second settlement after suspension.
    @discardableResult
    func connectRemoteTransferringActivation(
        _ connection: RemoteConnection,
        lease: RemoteRuntimeActivationLease
    ) async -> GatewayClient? {
        await connectRemoteCore(
            connection.id,
            allowInteraction: false,
            transferredActivation: (lease, connection))
    }

    private func connectRemoteCore(
        _ id: UUID,
        allowInteraction: Bool,
        transferredActivation: (lease: RemoteRuntimeActivationLease, connection: RemoteConnection)?
    ) async -> GatewayClient? {
        if let existing = remoteConnectTasks[id] {
            if let transferredActivation {
                let failure = await remoteActivationFailure(
                    SSHConnectionError.unavailable(
                        "another reconnect claimed this host before activation verification"),
                    lease: transferredActivation.lease,
                    on: transferredActivation.connection)
                if remoteConnections.contains(where: { $0.id == id }) {
                    setRemoteState(id, .failed, message: failure.message)
                } else if failure.rollbackFailed {
                    threadStatus = failure.message
                }
                return nil
            }
            let generation = remoteConnectionGenerations[id] ?? 0
            await existing.value
            guard remoteConnectionGenerations[id] == generation else { return nil }
            if allowInteraction,
               remoteConnections.first(where: { $0.id == id })?.status == .needsInteraction
            {
                remoteConnectTasks.removeValue(forKey: id)
                return await connectRemote(id, allowInteraction: true)
            }
            return remoteClients[.remote(id)]
        }
        let generation = (remoteConnectionGenerations[id] ?? 0) + 1
        remoteConnectionGenerations[id] = generation
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.connectRemoteOnce(
                id,
                allowInteraction: allowInteraction,
                generation: generation,
                transferredActivation: transferredActivation)
        }
        remoteConnectTasks[id] = task
        await task.value
        if remoteConnectionGenerations[id] == generation {
            remoteConnectTasks.removeValue(forKey: id)
        }
        guard remoteConnectionGenerations[id] == generation else { return nil }
        return remoteClients[.remote(id)]
    }

    private func connectRemoteOnce(
        _ id: UUID,
        allowInteraction: Bool,
        generation: Int,
        transferredActivation:
            (lease: RemoteRuntimeActivationLease, connection: RemoteConnection)?
    ) async {
        guard remoteConnectionGenerations[id] == generation,
              var connection = remoteConnections.first(where: { $0.id == id })
        else {
            if let transferredActivation {
                let failure = await remoteActivationFailure(
                    CancellationError(),
                    lease: transferredActivation.lease,
                    on: transferredActivation.connection)
                if failure.rollbackFailed { threadStatus = failure.message }
            }
            return
        }
        let locationID = connection.locationID
        // A new connection generation replaces one daemon epoch. Retire its
        // client first, then every volatile projection; persisted thread titles
        // and connection preferences intentionally survive for offline UI.
        remoteClients.removeValue(forKey: locationID)
        cancelRemoteStreams(locationID)
        discardRemoteDaemonProjections(at: locationID)
        var activationLease = transferredActivation?.lease
        setRemoteState(id, .connecting, message: "Connecting with OpenSSH…")
        do {
            try await sshConnectionManager.connectBatch(connection)
        } catch let error as SSHConnectionError {
            if activationLease != nil {
                let failure = await remoteActivationFailure(
                    error, lease: activationLease, on: connection)
                activationLease = nil
                guard remoteConnectionGenerations[id] == generation else {
                    if failure.rollbackFailed { threadStatus = failure.message }
                    return
                }
                setRemoteState(id, .failed, message: failure.message)
                return
            }
            guard remoteConnectionGenerations[id] == generation else { return }
            if case .needsInteraction = error {
                guard allowInteraction, remoteTerminalSheet == nil else {
                    setRemoteState(
                        id, .needsInteraction,
                        message: "SSH needs authentication. Click Connect to open its terminal.")
                    return
                }
                guard let presentation = beginRemoteTerminalPresentation(
                    connectionID: id)
                else { return }
                setRemoteState(
                    id, .needsInteraction,
                    message: "Preparing the SSH authentication terminal…")
                do {
                    let invocation =
                        try await sshConnectionManager.interactiveMasterInvocation(for: connection)
                    guard remoteConnectionGenerations[id] == generation else {
                        finishRemoteTerminalPresentation(presentation)
                        return
                    }
                    guard remoteTerminalPresentationIsCurrent(presentation) else {
                        recordSupersededRemoteAuthentication(
                            connectionID: id,
                            generation: generation,
                            presentation: presentation)
                        return
                    }
                    setRemoteState(
                        id, .needsInteraction,
                        message: "Finish SSH authentication in the terminal.")
                    _ = presentRemoteTerminal(
                        presentation,
                        title: "Connect to \(connection.displayName)",
                        invocation: invocation,
                        purpose: .authentication(id, generation))
                } catch {
                    guard remoteConnectionGenerations[id] == generation else { return }
                    guard remoteTerminalPresentationIsCurrent(presentation) else {
                        recordSupersededRemoteAuthentication(
                            connectionID: id,
                            generation: generation,
                            presentation: presentation)
                        return
                    }
                    finishRemoteTerminalPresentation(presentation)
                    setRemoteState(id, .failed, message: userMessageForRemote(error))
                }
                return
            }
            setRemoteState(id, .failed, message: userMessageForRemote(error))
            return
        } catch {
            if activationLease != nil {
                let failure = await remoteActivationFailure(
                    error, lease: activationLease, on: connection)
                activationLease = nil
                guard remoteConnectionGenerations[id] == generation else {
                    if failure.rollbackFailed { threadStatus = failure.message }
                    return
                }
                setRemoteState(id, .failed, message: failure.message)
                return
            }
            guard remoteConnectionGenerations[id] == generation else { return }
            setRemoteState(id, .failed, message: userMessageForRemote(error))
            return
        }

        do {
            guard remoteConnectionGenerations[id] == generation else {
                // A later disconnect/connect generation owns this id now. A
                // generic cleanup here could tear down its newer SSH master.
                return
            }
            connection = remoteConnections.first(where: { $0.id == id }) ?? connection
            if activationLease == nil {
                try await remoteRuntimeInstaller.recoverPendingActivation(on: connection)
            }
            let detectedTarget = try await remoteRuntimeInstaller.detectTarget(on: connection)
            var probe = try? await remoteRuntimeInstaller.probe(on: connection)
            if probe?.target != detectedTarget { probe = nil }
            let manifest = try? await remoteRuntimeInstaller.loadManifest()

            if probe == nil {
                guard let manifest else {
                    throw SSHConnectionError.unavailable(
                        "the runtime is missing and the signed release manifest is unavailable")
                }
                setRemoteState(id, .installing, message: "Installing the remote runtime…")
                activationLease = try await remoteRuntimeInstaller.install(
                    manifest, target: detectedTarget, on: connection,
                    appVersion: Self.appVersionString())
                probe = try await remoteRuntimeInstaller.probe(on: connection)
            } else if let manifest, let probe {
                switch decideRemoteRuntime(
                    probe: probe,
                    manifest: manifest,
                    appVersion: Self.appVersionString(),
                    hasActiveTasks: false)
                {
                case .blockingUpdate:
                    setRemoteState(id, .installing, message: "Updating an incompatible runtime…")
                    activationLease = try await remoteRuntimeInstaller.install(
                        manifest, target: detectedTarget, on: connection,
                        appVersion: Self.appVersionString())
                case .appUpdateRequired:
                    throw SSHConnectionError.unavailable(
                        "this host needs a newer Claudexor app; the runtime was not downgraded")
                default:
                    break
                }
            }

            guard remoteConnectionGenerations[id] == generation else {
                throw CancellationError()
            }
            var activeBootstrap = try await bootstrapRemoteClient(
                connection, generation: generation)
            if activationLease == nil, let manifest {
                let hasActive = (try? await activeBootstrap.client.engineHasActiveWork()) ?? true
                switch decideRemoteRuntime(
                    probe: activeBootstrap.runtime,
                    manifest: manifest,
                    appVersion: Self.appVersionString(),
                    hasActiveTasks: hasActive)
                {
                case .updateAvailable:
                    setRemoteState(id, .installing, message: "Updating the remote runtime…")
                    await closeRemoteControlForward(id, through: generation)
                    activationLease = try await remoteRuntimeInstaller.install(
                        manifest, target: detectedTarget, on: connection,
                        appVersion: Self.appVersionString())
                    activeBootstrap = try await bootstrapRemoteClient(
                        connection, generation: generation)
                case .useCurrentAndOfferUpdate:
                    remoteConnectionMessages[id] =
                        "Connected. A compatible runtime update will be offered after active tasks finish."
                default:
                    break
                }
            }
            let activeClient = activeBootstrap.client
            var publicationGate = RemoteRuntimePublicationGate(
                expectedRuntime: activeBootstrap.runtime,
                requiresActivationCommit: activationLease != nil)
            let outcome = try await activeClient.handshake()
            // Issue #165 C7b: publication requires NORMAL serving — a
            // recovery-only remote daemon must not be adopted (absent
            // servingMode = a pre-#165 daemon serving normally).
            guard outcome.ok, !outcome.recoveryOnly,
                  publicationGate.acceptHandshake(outcome.engine)
            else {
                throw SSHConnectionError.unavailable(
                    "remote daemon handshake does not match the bootstrapped runtime or is serving recovery only")
            }
            guard remoteConnectionGenerations[id] == generation else {
                throw CancellationError()
            }
            if let lease = activationLease {
                try await remoteRuntimeInstaller.commitActivation(
                    lease, serving: activeBootstrap.runtime, on: connection)
                // A later final-probe mismatch belongs to a newer pointer actor;
                // never roll it back with this already-settled lease.
                activationLease = nil
                guard publicationGate.acceptActivationCommit() else {
                    throw SSHConnectionError.unavailable(
                        "remote runtime activation committed before its handshake")
                }
            }
            guard remoteConnectionGenerations[id] == generation else {
                await closeRemoteControlForward(id, through: generation)
                return
            }
            guard let harnessLease = claimHarnessProjection(
                at: connection.locationID,
                client: activeClient,
                requireCurrentClient: false)
            else { return }
            async let settings = activeClient.settings()
            async let projects = activeClient.listProjects()
            async let trust = activeClient.trustList()
            // Remote connect mirrors local connect: cached registry/readiness +
            // harness status. Quota is subscriber-owned and the expensive
            // atomic snapshot is explicit-only.
            async let credentials = activeClient.credentialProfiles()
            async let harnesses = activeClient.listHarnessStatus()
            async let secrets = activeClient.listSecrets()
            let settingsValue = try? await settings
            let projectValue = try? await projects
            let trustValue = try? await trust
            let credentialValue = try? await credentials
            let harnessValue = try? await harnesses
            let secretValue = try? await secrets
            let finalProbe = try await remoteRuntimeInstaller.probe(on: connection)
            guard !Task.isCancelled,
                  remoteConnectionGenerations[id] == generation
            else {
                await closeRemoteControlForward(id, through: generation)
                return
            }
            guard publicationGate.acceptCurrentRuntime(finalProbe),
                  publicationGate.mayPublish
            else {
                throw SSHConnectionError.unavailable(
                    "remote runtime changed before its client could be published")
            }
            adoptRemoteClientForReconnect(activeClient, at: connection.locationID)
            if let harnessValue {
                _ = acceptHarnessSnapshot(
                    harnessValue.harnesses,
                    git: harnessValue.git,
                    lease: harnessLease)
            } else {
                remoteHarnessReadinessFresh[connection.locationID] = false
                remoteGitCapabilities.removeValue(forKey: connection.locationID)
            }
            if let settingsValue {
                remoteSettingsSnapshots[connection.locationID] = settingsValue
            }
            if let projectValue {
                remoteProjects[connection.locationID] = projectValue.projects
            }
            if let trustValue {
                remoteTrustEntries[connection.locationID] = trustValue.entries
            }
            if let credentialValue {
                storeCredentialProfiles(
                    credentialValue.profiles,
                    harnessAccounts: credentialValue.harnessAccounts,
                    at: connection.locationID)
                accountsRegistryLoadStates[connection.locationID] = .loaded
                accountsReadinessAuthorityFresh[connection.locationID] = true
                accountsNextUpAuthorityFresh[connection.locationID] = false
            }
            // Existing remote Accounts/Quota views retain their subscription
            // across tunnel recovery; resume their display-only read now that
            // this exact client owns the location.
            scheduleAccountsQuotaDisplayHydration(at: connection.locationID)
            if let secretValue {
                remoteSecretBackends[connection.locationID] = secretValue.backend
                remoteStoredSecrets[connection.locationID] = secretValue.secrets
            }
            mutateRemoteConnection(id) {
                $0.status = .connected
                $0.runtimeVersion = finalProbe.version
                $0.lastConnectedAt = .now
            }
            remoteConnectionMessages[id] =
                remoteConnectionMessages[id]?.hasPrefix("Connected. A compatible runtime update") == true
                ? remoteConnectionMessages[id]
                : "Connected through an SSH tunnel."
            await refreshRemoteThreads(connection.locationID)
            guard !Task.isCancelled,
                  remoteConnectionGenerations[id] == generation,
                  remoteClients[connection.locationID] === activeClient
            else { return }
            startRemoteGlobalStream(connection.locationID)
        } catch {
            let failure = await remoteActivationFailure(
                error, lease: activationLease, on: connection)
            activationLease = nil
            guard remoteConnectionGenerations[id] == generation else {
                if failure.rollbackFailed {
                    threadStatus = failure.message
                }
                return
            }
            await closeRemoteControlForward(id, through: generation)
            remoteClients.removeValue(forKey: connection.locationID)
            cancelRemoteStreams(connection.locationID)
            discardRemoteDaemonProjections(at: connection.locationID)
            setRemoteState(id, .failed, message: failure.message)
        }
    }

    func finishInteractiveRemoteConnection(
        _ id: UUID,
        generation: Int,
        exitCode: Int32
    ) async {
        guard remoteConnectionGenerations[id] == generation,
              let connection = remoteConnections.first(where: { $0.id == id }),
              connection.status == .needsInteraction
        else { return }
        guard exitCode == 0 else {
            setRemoteState(id, .failed, message: "Interactive SSH authentication did not finish.")
            return
        }
        do {
            try await sshConnectionManager.adoptInteractiveMaster(connection)
            await connectRemote(id)
            if let pending = pendingRemoteThreadSelection,
               pending.locationID == connection.locationID,
               gateway(for: pending.locationID) != nil
            {
                pendingRemoteThreadSelection = nil
                await openThread(locationID: pending.locationID, id: pending.threadID)
            }
        } catch {
            setRemoteState(id, .failed, message: userMessageForRemote(error))
        }
    }

    @discardableResult
    func disconnectRemote(_ id: UUID) async -> Int? {
        let locationID = ExecutionLocationID.remote(id)
        let generation = (remoteConnectionGenerations[id] ?? 0) + 1
        remoteConnectionGenerations[id] = generation
        retireRemoteActions(for: id)
        retireRemoteTerminalPresentation(for: id)
        remoteConnectTasks.removeValue(forKey: id)?.cancel()
        if let purpose = settingsRemoteTerminalSheet?.purpose,
           case .install(let lease, _) = purpose,
           lease.connectionID == id
        {
            settingsRemoteTerminalSheet = nil
        }
        if remoteHarnessInstallPrompt?.connectionID == id {
            remoteHarnessInstallPrompt = nil
        }
        if remoteDeviceLogin?.connectionID == id { remoteDeviceLogin = nil }
        if remotePreview?.connectionID == id { remotePreview = nil }
        if remoteDirectoryBrowser?.connectionID == id { remoteDirectoryBrowser = nil }
        if pendingRemoteThreadSelection?.locationID == locationID {
            pendingRemoteThreadSelection = nil
        }
        remoteClients.removeValue(forKey: locationID)
        cancelRemoteStreams(locationID)
        discardRemoteDaemonProjections(at: locationID)
        await closeRemoteControlForward(id, through: generation)
        guard remoteConnectionGenerations[id] == generation else { return nil }
        if let forward = remotePreviewForwards.removeValue(forKey: id) {
            await sshConnectionManager.closeForward(forward.forward)
            guard remoteConnectionGenerations[id] == generation else { return nil }
        }
        await sshConnectionManager.disconnect(id)
        guard remoteConnectionGenerations[id] == generation else { return nil }
        setRemoteState(id, .offline, message: "Disconnected. Cached thread titles remain available.")
        return generation
    }

    func shutdownRemoteConnections() async {
        for id in remoteConnections.map(\.id) {
            remoteConnectionGenerations[id, default: 0] += 1
        }
        let connectTasks = Array(remoteConnectTasks.values)
        remoteConnectTasks.removeAll()
        for task in connectTasks { task.cancel() }
        let locationIDs = Set(remoteConnections.map(\.locationID)).union(remoteClients.keys)
        // Retire every client/projection synchronously before the first await.
        // Cancellation is cooperative; an old request may otherwise complete
        // while shutdown is waiting for a connection task and repaint state.
        remoteClients.removeAll()
        remoteTerminalPresentationLease = nil
        remoteTerminalSheet = nil
        for locationID in locationIDs {
            cancelRemoteStreams(locationID)
            discardRemoteDaemonProjections(at: locationID)
        }
        for task in remoteGlobalStreamTasks.values { task.cancel() }
        for task in remoteRunStreamTasks.values { task.cancel() }
        remoteGlobalStreamTasks.removeAll()
        remoteGlobalStreamTokens.removeAll()
        remoteGlobalEventCursors.removeAll()
        remoteRunStreamTasks.removeAll()
        remoteRunStreamTokens.removeAll()
        for task in connectTasks { await task.value }
        remoteControlForwards.removeAll()
        remotePreviewForwards.removeAll()
        remoteActionLeases.removeAll()
        settingsRemoteTerminalSheet = nil
        remoteHarnessInstallPrompt = nil
        await sshConnectionManager.shutdown()
        // A cancellation-aware child may settle just as the first shutdown pass
        // snapshots the registry. A second idempotent pass closes anything that
        // became visible during task teardown.
        await sshConnectionManager.shutdown()
    }

    private func bootstrapRemoteClient(
        _ connection: RemoteConnection,
        generation: Int
    ) async throws
        -> RemoteRuntimeGatewayBootstrap
    {
        await closeRemoteControlForward(connection.id, through: generation)
        guard remoteConnectionGenerations[connection.id] == generation else {
            throw CancellationError()
        }
        let bootstrap = try await remoteRuntimeInstaller.bootstrap(on: connection)
        guard remoteConnectionGenerations[connection.id] == generation else {
            throw CancellationError()
        }
        let currentRuntime = try await remoteRuntimeInstaller.probe(on: connection)
        guard currentRuntime == bootstrap.runtime else {
            throw SSHConnectionError.unavailable(
                "remote runtime changed while its daemon was bootstrapping")
        }
        guard remoteConnectionGenerations[connection.id] == generation else {
            throw CancellationError()
        }
        let forward = try await sshConnectionManager.openForward(
            connection, remotePort: bootstrap.endpoint.port)
        guard remoteConnectionGenerations[connection.id] == generation else {
            await sshConnectionManager.closeForward(forward)
            throw CancellationError()
        }
        remoteControlForwards[connection.id] = RemoteControlForwardLease(
            generation: generation, forward: forward)
        return RemoteRuntimeGatewayBootstrap(
            client: GatewayClient(
                baseURL: URL(string: "http://127.0.0.1:\(forward.localPort)")!,
                token: bootstrap.endpoint.token),
            runtime: bootstrap.runtime)
    }

    private func closeRemoteControlForward(_ id: UUID, through generation: Int) async {
        guard let lease = remoteControlForwards[id], lease.generation <= generation else { return }
        remoteControlForwards.removeValue(forKey: id)
        await sshConnectionManager.closeForward(lease.forward)
    }

    /// Settle only the exact activation created by the failed caller. Rollback
    /// failure is part of the primary user-visible error because the remote
    /// pointer may still reference a candidate that did not pass the tunneled
    /// Control handshake.
    func remoteActivationFailure(
        _ primaryError: Error,
        lease: RemoteRuntimeActivationLease?,
        on connection: RemoteConnection
    ) async -> (message: String, rollbackFailed: Bool) {
        let recovery = primaryError as? RemoteRuntimeRecoveryRequired
        let primaryMessage = recovery?.primaryMessage ?? userMessageForRemote(primaryError)
        guard let lease = recovery?.lease ?? lease else { return (primaryMessage, false) }
        do {
            try await remoteRuntimeInstaller.recoverActivation(lease, on: connection)
            return (primaryMessage, false)
        } catch {
            return (
                primaryMessage
                    + " Runtime recovery also failed: "
                    + userMessageForRemote(error),
                true)
        }
    }

}
