import ClaudexorKit
import Foundation

extension AppModel {
    @discardableResult
    func selectRemoteProject(connectionID: UUID, path: String) -> Task<Void, Never>? {
        let root = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty,
              remoteConnections.contains(where: { $0.id == connectionID })
        else { return nil }
        if selectedThreadId != nil { startDraftThread() }
        draftExecutionLocation = .remote(connectionID)
        draftRemoteProjectRoot = root
        mutateRemoteConnection(connectionID) {
            $0.savedProjects.removeAll { $0 == root }
            $0.savedProjects.insert(root, at: 0)
            $0.savedProjects = Array($0.savedProjects.prefix(20))
        }
        guard let client = remoteClients[.remote(connectionID)],
              let lease = beginRemoteAction(.projectRegistration, connectionID: connectionID)
        else { return nil }
        return Task {
            defer { finishRemoteAction(lease) }
            do {
                let registered = try await client.registerProject(root: root)
                guard remoteActionIsCurrent(lease, client: client) else { return }
                let locationID = ExecutionLocationID.remote(connectionID)
                var projects = remoteProjects[locationID] ?? []
                projects.removeAll { $0.id == registered.id || $0.root == registered.root }
                projects.insert(registered, at: 0)
                remoteProjects[locationID] = projects
                remoteConnectionMessages[connectionID] =
                    "Registered \(root) as a remote project."
            } catch {
                guard remoteActionIsCurrent(lease, client: client) else { return }
                remoteConnectionMessages[connectionID] =
                    "Could not register \(root): \(userMessage(for: error))"
            }
        }
    }

    func showRemoteDirectoryBrowser(connectionID: UUID) {
        guard let admittedLease = beginRemoteAction(
            .directoryBrowser, connectionID: connectionID)
        else { return }
        if remoteClients[.remote(connectionID)] == nil {
            Task {
                await connectRemote(connectionID)
                guard let lease = rebindRemoteActionToCurrentGeneration(admittedLease) else {
                    finishRemoteAction(admittedLease)
                    return
                }
                guard remoteClients[.remote(connectionID)] != nil else {
                    finishRemoteAction(lease)
                    return
                }
                remoteDirectoryBrowser = RemoteDirectoryBrowserRequest(lease: lease)
            }
        } else {
            remoteDirectoryBrowser = RemoteDirectoryBrowserRequest(lease: admittedLease)
        }
    }

    func dismissRemoteDirectoryBrowser(_ request: RemoteDirectoryBrowserRequest) {
        if remoteDirectoryBrowser?.lease == request.lease {
            remoteDirectoryBrowser = nil
        }
        finishRemoteAction(request.lease)
    }

    func openRemoteTerminal(directory: String, title: String? = nil) async {
        guard let connection = selectedRemoteConnection,
              let presentation = beginRemoteTerminalPresentation(
                connectionID: connection.id)
        else { return }
        do {
            let invocation = try await sshConnectionManager.terminalShellInvocation(
                connection, directory: directory)
            _ = presentRemoteTerminal(
                presentation,
                title: title ?? "Terminal — \(connection.displayName)",
                invocation: invocation,
                purpose: .shell)
        } catch {
            guard remoteTerminalPresentationIsCurrent(presentation) else { return }
            finishRemoteTerminalPresentation(presentation)
            threadStatus = userMessageForRemote(error)
        }
    }

    func openRemoteDaemonLog() async {
        guard let connection = selectedRemoteConnection,
              let presentation = beginRemoteTerminalPresentation(
                connectionID: connection.id)
        else { return }
        do {
            let factory = try await sshConnectionManager.factory(for: connection)
            let command =
                "tail -n 200 -f \"$HOME/.claudexor/v3/daemon/claudexord.log\""
            _ = presentRemoteTerminal(
                presentation,
                title: "Daemon log — \(connection.displayName)",
                invocation: factory.remoteCommand(command, requestTTY: true),
                purpose: .log)
        } catch {
            guard remoteTerminalPresentationIsCurrent(presentation) else { return }
            finishRemoteTerminalPresentation(presentation)
            threadStatus = userMessageForRemote(error)
        }
    }

    func openRemotePreview(remotePort: Int) async {
        guard let connection = selectedRemoteConnection,
              (1 ... 65_535).contains(remotePort)
        else { return }
        guard let lease = beginRemoteAction(.preview, connectionID: connection.id) else { return }
        let oldForwards = Array(remotePreviewForwards.values)
        remotePreviewForwards.removeAll()
        remotePreview = nil
        for old in oldForwards {
            await sshConnectionManager.closeForward(old.forward)
            guard remoteActionIsCurrent(lease) else { return }
        }
        do {
            let forward = try await sshConnectionManager.openForward(
                connection, remotePort: remotePort)
            _ = await acceptRemotePreviewForward(
                forward, lease: lease, remotePort: remotePort)
        } catch {
            guard remoteActionIsCurrent(lease) else { return }
            threadStatus = userMessageForRemote(error)
            finishRemoteAction(lease)
        }
    }

    @discardableResult
    func acceptRemotePreviewForward(
        _ forward: SSHForward,
        lease: RemoteActionLease,
        remotePort: Int
    ) async -> Bool {
        guard remoteActionIsCurrent(lease) else {
            await sshConnectionManager.closeForward(forward)
            return false
        }
        remotePreviewForwards[lease.connectionID] = RemotePreviewForwardLease(
            action: lease, forward: forward)
        remotePreview = RemotePreviewRequest(
            lease: lease, localPort: forward.localPort, remotePort: remotePort)
        return true
    }

    func closeRemotePreview(_ request: RemotePreviewRequest) async {
        if remotePreview?.lease == request.lease { remotePreview = nil }
        guard let stored = remotePreviewForwards[request.connectionID],
              stored.action == request.lease
        else { return }
        remotePreviewForwards.removeValue(forKey: request.connectionID)
        finishRemoteAction(request.lease)
        await sshConnectionManager.closeForward(stored.forward)
    }
}
