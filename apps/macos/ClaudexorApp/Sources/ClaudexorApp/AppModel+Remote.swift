import ClaudexorKit
import Foundation

struct RemoteDirectoryBrowserRequest: Identifiable, Equatable {
    let id = UUID()
    let connectionID: UUID
}

enum RemoteTerminalPurpose: Equatable {
    case authentication(UUID, Int)
    case shell
    case setup(UUID, String)
    case install(UUID, String)
    case log

    var blocksDismissalWhileRunning: Bool {
        switch self {
        case .authentication, .setup, .install:
            return true
        case .shell, .log:
            return false
        }
    }
}

struct RemoteTerminalSheetRequest: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let invocation: SSHInvocation
    let purpose: RemoteTerminalPurpose
}

struct RemotePreviewRequest: Identifiable, Equatable {
    let id: UUID
    let connectionID: UUID
    let localPort: Int
    let remotePort: Int
}

struct RemoteDeviceLoginRequest: Identifiable, Equatable {
    let id = UUID()
    let connectionID: UUID
    let jobID: String
}

extension AppModel {
    var locatedThreads: [LocatedThread] {
        let local = threads.map { LocatedThread(locationID: .local, thread: $0) }
        let remote = remoteThreadCache.map {
            LocatedThread(locationID: $0.locationID, thread: $0.thread)
        }
        return (local + remote).sorted {
            Self.threadSortDate($0.thread) > Self.threadSortDate($1.thread)
        }
    }

    var selectedLocatedThreadID: String? {
        guard let selectedThreadId else { return nil }
        return "\(selectedExecutionLocation.rawValue)|\(selectedThreadId)"
    }

    var selectedRemoteConnection: RemoteConnection? {
        guard let id = selectedExecutionLocation.remoteConnectionID else { return nil }
        return remoteConnections.first { $0.id == id }
    }

    func remoteConnection(for locationID: ExecutionLocationID) -> RemoteConnection? {
        guard let id = locationID.remoteConnectionID else { return nil }
        return remoteConnections.first { $0.id == id }
    }

    func gateway(for locationID: ExecutionLocationID) -> GatewayClient? {
        locationID == .local ? client : remoteClients[locationID]
    }

    func refreshSSHHosts() {
        sshHostScan = SSHHostScanState.scan()
    }

    /// "Create & Add" in ONE step: append the `Host` block through the Kit
    /// writer, rescan, and immediately create the `RemoteConnection`. Typed
    /// writer refusals propagate to the sheet (mapped to their owning field);
    /// a write-succeeded-but-add-failed partial outcome is carried on the
    /// receipt explicitly — never silently lost.
    func createSSHHostConnection(_ draft: SSHHostDraft) throws -> SSHHostCreationReceipt {
        let receipt = try SSHConfigWriter().appendHost(draft)
        refreshSSHHosts()
        let failure = addRemoteConnection(alias: receipt.alias)
        return SSHHostCreationReceipt(
            alias: receipt.alias,
            configPath: receipt.configPath,
            backupPath: receipt.backupPath,
            createdConfig: receipt.createdConfig,
            appendedBlock: receipt.appendedBlock,
            connectionFailure: failure)
    }

    /// Add an execution location for a config alias. Returns nil on success or
    /// the user-facing refusal reason — callers surface it (the old Void
    /// signature parked the OpenSSH resolve failure under a random UUID key
    /// that no view ever read).
    @discardableResult
    func addRemoteConnection(alias: String) -> String? {
        guard SSHConfigScanner.isConcreteAlias(alias) else {
            return "“\(alias)” is not a concrete Host alias."
        }
        guard !remoteConnections.contains(where: { $0.sshAlias == alias }) else {
            return "“\(alias)” is already added as a connection."
        }
        // Resolve with OpenSSH before persisting. This catches misspelled aliases
        // while preserving all key/agent/ProxyJump semantics in ssh itself.
        guard (try? OpenSSHResolver().resolve(alias: alias)) != nil else {
            return "OpenSSH could not resolve “\(alias)”."
        }
        remoteConnections.append(RemoteConnection(sshAlias: alias))
        persistRemoteConnections()
        return nil
    }

    func removeRemoteConnection(_ id: UUID) async {
        await disconnectRemote(id)
        remoteConnections.removeAll { $0.id == id }
        remoteThreadCache.removeAll { $0.locationID.remoteConnectionID == id }
        persistRemoteConnections()
        persistRemoteThreadCache()
    }

    func setRemoteNickname(_ id: UUID, nickname: String) {
        mutateRemoteConnection(id) {
            $0.nickname = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    func setRemoteEnabled(_ id: UUID, enabled: Bool) {
        mutateRemoteConnection(id) { $0.enabled = enabled }
    }

    func connectRemote(_ id: UUID, allowInteraction: Bool = true) async {
        if let existing = remoteConnectTasks[id] {
            await existing.value
            if allowInteraction,
               remoteConnections.first(where: { $0.id == id })?.status == .needsInteraction
            {
                remoteConnectTasks.removeValue(forKey: id)
                await connectRemote(id, allowInteraction: true)
            }
            return
        }
        let generation = (remoteConnectionGenerations[id] ?? 0) + 1
        remoteConnectionGenerations[id] = generation
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.connectRemoteOnce(
                id, allowInteraction: allowInteraction, generation: generation)
        }
        remoteConnectTasks[id] = task
        await task.value
        if remoteConnectionGenerations[id] == generation {
            remoteConnectTasks.removeValue(forKey: id)
        }
    }

    private func connectRemoteOnce(
        _ id: UUID,
        allowInteraction: Bool,
        generation: Int
    ) async {
        guard remoteConnectionGenerations[id] == generation,
              var connection = remoteConnections.first(where: { $0.id == id })
        else { return }
        var switchedRuntime = false
        setRemoteState(id, .connecting, message: "Connecting with OpenSSH…")
        do {
            try await sshConnectionManager.connectBatch(connection)
        } catch let error as SSHConnectionError {
            guard remoteConnectionGenerations[id] == generation else { return }
            if case .needsInteraction = error {
                guard allowInteraction, remoteTerminalSheet == nil else {
                    setRemoteState(
                        id, .needsInteraction,
                        message: "SSH needs authentication. Click Connect to open its terminal.")
                    return
                }
                do {
                    let invocation =
                        try await sshConnectionManager.interactiveMasterInvocation(for: connection)
                    setRemoteState(
                        id, .needsInteraction,
                        message: "Finish SSH authentication in the terminal.")
                    remoteTerminalSheet = RemoteTerminalSheetRequest(
                        title: "Connect to \(connection.displayName)",
                        invocation: invocation,
                        purpose: .authentication(id, generation))
                } catch {
                    setRemoteState(id, .failed, message: userMessageForRemote(error))
                }
                return
            }
            setRemoteState(id, .failed, message: userMessageForRemote(error))
            return
        } catch {
            guard remoteConnectionGenerations[id] == generation else { return }
            setRemoteState(id, .failed, message: userMessageForRemote(error))
            return
        }

        do {
            guard remoteConnectionGenerations[id] == generation else {
                // A disconnect may have raced the initially blocking ssh launch
                // before the actor had recorded the new master. Close the master
                // that just became live instead of leaving an orphan socket.
                await sshConnectionManager.disconnect(id)
                return
            }
            connection = remoteConnections.first(where: { $0.id == id }) ?? connection
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
                try await remoteRuntimeInstaller.install(
                    manifest, target: detectedTarget, on: connection,
                    appVersion: Self.appVersionString())
                switchedRuntime = true
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
                    try await remoteRuntimeInstaller.install(
                        manifest, target: detectedTarget, on: connection,
                        appVersion: Self.appVersionString())
                    switchedRuntime = true
                case .appUpdateRequired:
                    throw SSHConnectionError.unavailable(
                        "this host needs a newer Claudexor app; the runtime was not downgraded")
                default:
                    break
                }
            }

            guard remoteConnectionGenerations[id] == generation else { return }
            var activeClient = try await bootstrapRemoteClient(connection)
            if let manifest, let currentProbe = try? await remoteRuntimeInstaller.probe(on: connection) {
                let hasActive = (try? await activeClient.engineHasActiveWork()) ?? true
                switch decideRemoteRuntime(
                    probe: currentProbe,
                    manifest: manifest,
                    appVersion: Self.appVersionString(),
                    hasActiveTasks: hasActive)
                {
                case .updateAvailable:
                    setRemoteState(id, .installing, message: "Updating the remote runtime…")
                    await closeRemoteControlForward(id)
                    try await remoteRuntimeInstaller.install(
                        manifest, target: detectedTarget, on: connection,
                        appVersion: Self.appVersionString())
                    switchedRuntime = true
                    activeClient = try await bootstrapRemoteClient(connection)
                case .useCurrentAndOfferUpdate:
                    remoteConnectionMessages[id] =
                        "Connected. A compatible runtime update will be offered after active tasks finish."
                default:
                    break
                }
            }
            let outcome = try await activeClient.handshake()
            guard outcome.ok else {
                throw SSHConnectionError.unavailable("remote daemon handshake failed")
            }
            if switchedRuntime {
                await remoteRuntimeInstaller.commitActivation(on: connection)
                switchedRuntime = false
            }
            guard remoteConnectionGenerations[id] == generation else {
                await closeRemoteControlForward(id)
                return
            }
            async let harnessRows = activeClient.listHarnesses(fresh: true)
            async let settings = activeClient.settings()
            async let projects = activeClient.listProjects()
            async let trust = activeClient.trustList()
            async let credentials = activeClient.credentialProfiles()
            async let quota = activeClient.quota(refresh: false)
            async let secrets = activeClient.listSecrets()
            let harnessValue = try? await harnessRows
            let settingsValue = try? await settings
            let projectValue = try? await projects
            let trustValue = try? await trust
            let credentialValue = try? await credentials
            let quotaValue = try? await quota
            let secretValue = try? await secrets
            let finalProbe = try? await remoteRuntimeInstaller.probe(on: connection)
            guard !Task.isCancelled,
                  remoteConnectionGenerations[id] == generation
            else {
                await closeRemoteControlForward(id)
                return
            }
            remoteClients[connection.locationID] = activeClient
            if let harnessValue {
                remoteHarnesses[connection.locationID] =
                    Self.mapHarnessStatuses(harnessValue)
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
                remoteCredentialProfiles[connection.locationID] = credentialValue.profiles
                remoteHarnessAccounts[connection.locationID] = credentialValue.harnessAccounts
            }
            if let quotaValue {
                remoteQuotaResponses[connection.locationID] = quotaValue
            }
            if let secretValue {
                remoteSecretBackends[connection.locationID] = secretValue.backend
                remoteStoredSecrets[connection.locationID] = secretValue.secrets
            }
            mutateRemoteConnection(id) {
                $0.status = .connected
                $0.runtimeVersion = finalProbe?.version
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
            if switchedRuntime {
                await remoteRuntimeInstaller.rollbackOrDeactivate(on: connection)
            }
            guard remoteConnectionGenerations[id] == generation else { return }
            await closeRemoteControlForward(id)
            remoteClients.removeValue(forKey: connection.locationID)
            setRemoteState(id, .failed, message: userMessageForRemote(error))
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

    func disconnectRemote(_ id: UUID) async {
        remoteConnectionGenerations[id, default: 0] += 1
        remoteConnectTasks.removeValue(forKey: id)?.cancel()
        if let purpose = remoteTerminalSheet?.purpose,
           case .authentication(let sheetID, _) = purpose,
           sheetID == id
        {
            remoteTerminalSheet = nil
        }
        if let purpose = settingsRemoteTerminalSheet?.purpose,
           case .install(let sheetID, _) = purpose,
           sheetID == id
        {
            settingsRemoteTerminalSheet = nil
        }
        if remoteHarnessInstallPrompt?.connectionID == id {
            remoteHarnessInstallPrompt = nil
        }
        cancelRemoteStreams(.remote(id))
        await closeRemoteControlForward(id)
        if let forward = remotePreviewForwards.removeValue(forKey: id) {
            await sshConnectionManager.closeForward(forward)
        }
        remoteClients.removeValue(forKey: .remote(id))
        remoteHarnesses.removeValue(forKey: .remote(id))
        remoteSettingsSnapshots.removeValue(forKey: .remote(id))
        remoteQuotaResponses.removeValue(forKey: .remote(id))
        remoteSecretBackends.removeValue(forKey: .remote(id))
        remoteStoredSecrets.removeValue(forKey: .remote(id))
        remoteProjects.removeValue(forKey: .remote(id))
        remoteTasks.removeValue(forKey: .remote(id))
        await sshConnectionManager.disconnect(id)
        setRemoteState(id, .offline, message: "Disconnected. Cached thread titles remain available.")
    }

    func shutdownRemoteConnections() async {
        for id in remoteConnections.map(\.id) {
            remoteConnectionGenerations[id, default: 0] += 1
        }
        let connectTasks = Array(remoteConnectTasks.values)
        remoteConnectTasks.removeAll()
        for task in connectTasks { task.cancel() }
        for task in connectTasks { await task.value }
        for task in remoteGlobalStreamTasks.values { task.cancel() }
        for task in remoteRunStreamTasks.values { task.cancel() }
        remoteGlobalStreamTasks.removeAll()
        remoteGlobalEventCursors.removeAll()
        remoteRunStreamTasks.removeAll()
        remoteClients.removeAll()
        remoteHarnesses.removeAll()
        remoteSettingsSnapshots.removeAll()
        remoteQuotaResponses.removeAll()
        remoteSecretBackends.removeAll()
        remoteStoredSecrets.removeAll()
        remoteProjects.removeAll()
        remoteTasks.removeAll()
        remoteControlForwards.removeAll()
        remotePreviewForwards.removeAll()
        remoteTerminalSheet = nil
        settingsRemoteTerminalSheet = nil
        remoteHarnessInstallPrompt = nil
        await sshConnectionManager.shutdown()
        // A cancellation-aware child may settle just as the first shutdown pass
        // snapshots the registry. A second idempotent pass closes anything that
        // became visible during task teardown.
        await sshConnectionManager.shutdown()
    }

    func refreshRemoteThreads(_ locationID: ExecutionLocationID) async {
        guard let remote = remoteConnection(for: locationID),
              let client = remoteClients[locationID]
        else { return }
        do {
            let list = try await client.listThreads()
            let now = Date()
            remoteThreadCache.removeAll { $0.locationID == locationID }
            remoteThreadCache.append(contentsOf: list.threads.map {
                RemoteThreadCacheEntry(locationID: locationID, thread: $0, syncedAt: now)
            })
            persistRemoteThreadCache()
            await refreshRemoteRuns(locationID)
            for thread in list.threads {
                guard let runID = thread.headRunId,
                      remoteTasks[locationID]?.first(where: {
                          $0.id == runID
                      })?.phase.isActive == true
                else { continue }
                streamRemoteRun(
                    locationID: locationID, runID: runID, threadID: thread.id)
            }
            remoteConnectionMessages[remote.id] =
                list.droppedThreads == 0
                ? "Synced \(list.threads.count) thread(s)."
                : "Synced with \(list.droppedThreads) incompatible thread row(s) hidden."
        } catch {
            remoteConnectionMessages[remote.id] =
                "Could not sync; showing cached thread summaries."
        }
    }

    func refreshRemoteRuns(_ locationID: ExecutionLocationID) async {
        guard let client = remoteClients[locationID] else { return }
        do {
            let summaries = try await client.listRuns()
            guard remoteClients[locationID] === client else { return }
            let existingByID = Dictionary(
                uniqueKeysWithValues: (remoteTasks[locationID] ?? []).map { ($0.id, $0) })
            remoteTasks[locationID] = summaries.map {
                Self.mergeRefreshedTask(
                    summary: $0,
                    existing: existingByID[$0.runId]
                        ?? $0.jobId.flatMap { existingByID[$0] })
            }
        } catch {
            // Run transcripts and artifacts are intentionally memory-only.
        }
    }

    func remoteProjectFileReference(
        target: String
    ) -> (projectID: String, relativePath: String)? {
        let locationID = selectedExecutionLocation
        guard locationID != .local,
              let root = currentThread?.repoRoot,
              let project = remoteProjects[locationID]?.first(where: {
                  $0.root == root
              })
        else { return nil }
        var path = target
        if path.hasPrefix("file://") { path.removeFirst("file://".count) }
        let absolute: String
        if path.hasPrefix("/") {
            absolute = path
        } else {
            absolute = (root as NSString).appendingPathComponent(path)
        }
        let normalizedRoot = URL(fileURLWithPath: root).standardized.path
        let normalized = URL(fileURLWithPath: absolute).standardized.path
        let prefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
        guard normalized.hasPrefix(prefix) else { return nil }
        let relative = String(normalized.dropFirst(prefix.count))
        guard !relative.isEmpty,
              !relative.split(separator: "/").contains("..")
        else { return nil }
        return (project.id, relative)
    }

    private func bootstrapRemoteClient(_ connection: RemoteConnection) async throws
        -> GatewayClient
    {
        await closeRemoteControlForward(connection.id)
        let bootstrap = try await remoteRuntimeInstaller.bootstrap(on: connection)
        let forward = try await sshConnectionManager.openForward(
            connection, remotePort: bootstrap.endpoint.port)
        remoteControlForwards[connection.id] = forward
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:\(forward.localPort)")!,
            token: bootstrap.endpoint.token)
    }

    private func closeRemoteControlForward(_ id: UUID) async {
        guard let forward = remoteControlForwards.removeValue(forKey: id) else { return }
        await sshConnectionManager.closeForward(forward)
    }

    func setRemoteState(
        _ id: UUID,
        _ state: RemoteConnectionState,
        message: String
    ) {
        mutateRemoteConnection(id) { $0.status = state }
        remoteConnectionMessages[id] = message
    }

    func mutateRemoteConnection(
        _ id: UUID,
        mutation: (inout RemoteConnection) -> Void
    ) {
        guard let index = remoteConnections.firstIndex(where: { $0.id == id }) else { return }
        mutation(&remoteConnections[index])
        persistRemoteConnections()
    }

    private func persistRemoteConnections() {
        try? RemoteConnectionStore.applicationSupport().save(remoteConnections)
    }

    private func persistRemoteThreadCache() {
        try? RemoteThreadCacheStore.applicationSupport().save(remoteThreadCache)
    }

    func userMessageForRemote(_ error: Error) -> String {
        if isRecoverableRemoteTransportFailure(error) {
            return "The SSH tunnel is unavailable. Reconnect the host."
        }
        if let localized = error as? LocalizedError,
           let detail = localized.errorDescription, !detail.isEmpty
        {
            return detail
        }
        return userMessage(for: error)
    }

    private static func threadSortDate(_ thread: ThreadSummary) -> String {
        thread.updatedAt
    }
}
