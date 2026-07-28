import ClaudexorKit
import Foundation

struct RemoteNativeLoginReadiness: Equatable {
    let nativeSessionVerified: Bool
    let harnessRoutable: Bool
}

extension AppModel {
    func selectRemoteProject(connectionID: UUID, path: String) {
        let root = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty,
              remoteConnections.contains(where: { $0.id == connectionID })
        else { return }
        if selectedThreadId != nil { startDraftThread() }
        draftExecutionLocation = .remote(connectionID)
        draftRemoteProjectRoot = root
        mutateRemoteConnection(connectionID) {
            $0.savedProjects.removeAll { $0 == root }
            $0.savedProjects.insert(root, at: 0)
            $0.savedProjects = Array($0.savedProjects.prefix(20))
        }
        Task {
            guard let client = remoteClients[.remote(connectionID)] else { return }
            do {
                let registered = try await client.registerProject(root: root)
                let locationID = ExecutionLocationID.remote(connectionID)
                var projects = remoteProjects[locationID] ?? []
                projects.removeAll { $0.id == registered.id || $0.root == registered.root }
                projects.insert(registered, at: 0)
                remoteProjects[locationID] = projects
                remoteConnectionMessages[connectionID] =
                    "Registered \(root) as a remote project."
            } catch {
                remoteConnectionMessages[connectionID] =
                    "Could not register \(root): \(userMessage(for: error))"
            }
        }
    }

    func showRemoteDirectoryBrowser(connectionID: UUID) {
        if remoteClients[.remote(connectionID)] == nil {
            Task {
                await connectRemote(connectionID)
                if remoteClients[.remote(connectionID)] != nil {
                    remoteDirectoryBrowser = RemoteDirectoryBrowserRequest(
                        connectionID: connectionID)
                }
            }
        } else {
            remoteDirectoryBrowser = RemoteDirectoryBrowserRequest(connectionID: connectionID)
        }
    }

    func openRemoteTerminal(directory: String, title: String? = nil) async {
        guard let connection = selectedRemoteConnection else { return }
        do {
            let invocation = try await sshConnectionManager.terminalShellInvocation(
                connection, directory: directory)
            remoteTerminalSheet = RemoteTerminalSheetRequest(
                title: title ?? "Terminal — \(connection.displayName)",
                invocation: invocation,
                purpose: .shell)
        } catch {
            threadStatus = userMessageForRemote(error)
        }
    }

    func openRemoteDaemonLog() async {
        guard let connection = selectedRemoteConnection else { return }
        do {
            let factory = try await sshConnectionManager.factory(for: connection)
            let command =
                "tail -n 200 -f \"$HOME/.claudexor/v3/daemon/claudexord.log\""
            remoteTerminalSheet = RemoteTerminalSheetRequest(
                title: "Daemon log — \(connection.displayName)",
                invocation: factory.remoteCommand(command, requestTTY: true),
                purpose: .log)
        } catch {
            threadStatus = userMessageForRemote(error)
        }
    }

    func startRemoteLogin(
        connectionID: UUID,
        harness: SetupHarness,
        profileID: String? = nil
    ) async {
        let location = ExecutionLocationID.remote(connectionID)
        guard let connection = remoteConnections.first(where: { $0.id == connectionID })
        else { return }
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return }
        do {
            // Codex device auth remains daemon/API driven. Browser-redirect CLI
            // logins use the same sealed client_pty job as Claude/Cursor.
            let transport: SetupJobTransport = harness == .codex ? .daemon : .clientPty
            let job = try await client.createSetupJob(SetupJobCreateRequest(
                harness: harness,
                action: .login,
                profileId: profileID,
                loginFlow: harness == .codex ? .deviceAuth : nil,
                transport: transport))
            if transport == .clientPty {
                let invocation = try await sshConnectionManager.setupAttachInvocation(
                    connection, jobID: job.jobId)
                remoteTerminalSheet = RemoteTerminalSheetRequest(
                    title: "\(harness.rawValue.capitalized) login — \(connection.displayName)",
                    invocation: invocation,
                    purpose: .setup(connectionID, job.jobId))
            } else {
                remoteConnectionMessages[connectionID] =
                    "Codex device login started."
                remoteDeviceLogin = RemoteDeviceLoginRequest(
                    connectionID: connectionID, jobID: job.jobId)
            }
        } catch {
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
        }
    }

    func runRemoteHarnessDoctor(connectionID: UUID) async {
        let location = ExecutionLocationID.remote(connectionID)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return }
        do {
            let harnesses = try await client.listHarnesses(fresh: true)
            remoteHarnesses[location] = Self.mapHarnessStatuses(harnesses)
            let ready = harnesses.filter { !$0.routableIntents.isEmpty }.count
            remoteConnectionMessages[connectionID] =
                "Harness Doctor: \(ready) of \(harnesses.count) harnesses ready."
        } catch {
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
        }
    }

    func refreshRemoteNativeLoginReadiness(
        connectionID: UUID,
        harnessID: String
    ) async -> RemoteNativeLoginReadiness? {
        let location = ExecutionLocationID.remote(connectionID)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return nil }
        do {
            let harnesses = try await client.listHarnesses(fresh: true)
            remoteHarnesses[location] = Self.mapHarnessStatuses(harnesses)
            guard let harness = harnesses.first(where: { $0.id == harnessID }) else {
                remoteConnectionMessages[connectionID] =
                    "Harness Doctor did not return \(harnessID)."
                return nil
            }
            let readiness = RemoteNativeLoginReadiness(
                nativeSessionVerified:
                    harness.authSources.contains(where: \.isVerifiedNativeSession),
                harnessRoutable: !harness.routableIntents.isEmpty)
            if readiness.nativeSessionVerified && readiness.harnessRoutable {
                remoteConnectionMessages[connectionID] =
                    "\(harnessID.capitalized) is signed in and ready."
            } else {
                remoteConnectionMessages[connectionID] =
                    harness.reasons?.first ?? "\(harnessID.capitalized) is not ready yet."
            }
            return readiness
        } catch {
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
            return nil
        }
    }

    func installRemoteRuntime(connectionID: UUID) async {
        guard let connection = remoteConnections.first(where: {
            $0.id == connectionID
        }) else { return }
        setRemoteState(
            connectionID, .installing,
            message: "Downloading and verifying the signed runtime…")
        do {
            try await sshConnectionManager.connectBatch(connection)
            let target = try await remoteRuntimeInstaller.detectTarget(on: connection)
            let manifest = try await remoteRuntimeInstaller.loadManifest()
            try await remoteRuntimeInstaller.install(
                manifest, target: target, on: connection,
                appVersion: Self.appVersionString())
            await connectRemote(connectionID)
            guard remoteConnections.first(where: { $0.id == connectionID })?.status == .connected
            else {
                await remoteRuntimeInstaller.rollbackOrDeactivate(on: connection)
                return
            }
            await remoteRuntimeInstaller.commitActivation(on: connection)
        } catch {
            setRemoteState(
                connectionID, .failed, message: userMessageForRemote(error))
        }
    }

    func openRemotePreview(remotePort: Int) async {
        guard let connection = selectedRemoteConnection,
              (1 ... 65_535).contains(remotePort)
        else { return }
        if let old = remotePreviewForwards.removeValue(forKey: connection.id) {
            await sshConnectionManager.closeForward(old)
        }
        do {
            let forward = try await sshConnectionManager.openForward(
                connection, remotePort: remotePort)
            remotePreviewForwards[connection.id] = forward
            remotePreview = RemotePreviewRequest(
                id: UUID(), connectionID: connection.id,
                localPort: forward.localPort, remotePort: remotePort)
        } catch {
            threadStatus = userMessageForRemote(error)
        }
    }

    func closeRemotePreview(_ request: RemotePreviewRequest) async {
        remotePreview = nil
        guard let forward = remotePreviewForwards.removeValue(forKey: request.connectionID)
        else { return }
        await sshConnectionManager.closeForward(forward)
    }

    func startRemoteGlobalStream(_ locationID: ExecutionLocationID) {
        remoteGlobalStreamTasks[locationID]?.cancel()
        remoteGlobalStreamTasks[locationID] = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, let requestClient = self.remoteClients[locationID] else { break }
                do {
                    for try await event in requestClient.globalEvents(
                        lastEventId: self.remoteGlobalEventCursors[locationID])
                    {
                        guard self.remoteClients[locationID] === requestClient else { return }
                        self.remoteGlobalEventCursors[locationID] = event.cursor
                        await self.handleRemoteGlobalEvent(event, locationID: locationID)
                    }
                } catch let GatewayError.http(status, _)
                    where status == 400 || status == 409 || status == 410
                {
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch is DecodingError {
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch GatewayError.decoding {
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch {
                    if Task.isCancelled { break }
                }
                guard !Task.isCancelled,
                      self.remoteClients[locationID] === requestClient
                else { break }
                try? await Task.sleep(for: .seconds(3))
            }
            self?.remoteGlobalStreamTasks[locationID] = nil
        }
    }

    func streamRemoteRun(
        locationID: ExecutionLocationID,
        runID: String,
        threadID: String
    ) {
        let key = "\(locationID.rawValue)|\(runID)"
        guard remoteRunStreamTasks[key] == nil,
              let requestClient = remoteClients[locationID]
        else { return }
        remoteRunStreamTasks[key] = Task { @MainActor [weak self] in
            var lastEventID: Int?
            var lastDetailRefresh = Date.distantPast
            var attempt = 0
            while !Task.isCancelled {
                do {
                    for try await envelope in requestClient.events(
                        runId: runID, lastEventId: lastEventID)
                    {
                        guard let self,
                              self.remoteClients[locationID] === requestClient
                        else { return }
                        if envelope.seq > 0 { lastEventID = envelope.seq }
                        attempt = 0
                        if self.selectedExecutionLocation == locationID,
                           self.selectedThreadId == threadID,
                           Date().timeIntervalSince(lastDetailRefresh) >= 0.25
                        {
                            lastDetailRefresh = .now
                            await self.refreshOpenThread(
                                locationID: locationID, id: threadID)
                        }
                    }
                    break
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    if attempt > 5 { break }
                    try? await Task.sleep(for: .seconds(min(Double(attempt) * 2, 10)))
                }
            }
            guard let self else { return }
            await self.refreshRemoteThreads(locationID)
            if self.selectedExecutionLocation == locationID,
               self.selectedThreadId == threadID
            {
                await self.refreshOpenThread(
                    locationID: locationID, id: threadID)
            }
            self.remoteRunStreamTasks[key] = nil
        }
    }

    private func handleRemoteGlobalEvent(
        _ event: JournalEvent,
        locationID: ExecutionLocationID
    ) async {
        if event.type == "quota.snapshot.upserted" {
            guard let requestClient = remoteClients[locationID] else { return }
            if let response = try? await requestClient.quota(refresh: false) {
                remoteQuotaResponses[locationID] = response
            }
            return
        }
        guard event.type == "thread.head.updated" else { return }
        await refreshRemoteThreads(locationID)
        guard selectedExecutionLocation == locationID,
              let selectedThreadId,
              event.payload["thread_id"]?.stringValue == selectedThreadId
        else { return }
        await refreshOpenThread(locationID: locationID, id: selectedThreadId)
    }

    func cancelRemoteStreams(_ locationID: ExecutionLocationID) {
        remoteGlobalStreamTasks.removeValue(forKey: locationID)?.cancel()
        remoteGlobalEventCursors.removeValue(forKey: locationID)
        let prefix = "\(locationID.rawValue)|"
        for key in Array(remoteRunStreamTasks.keys) where key.hasPrefix(prefix) {
            remoteRunStreamTasks.removeValue(forKey: key)?.cancel()
        }
    }
}
