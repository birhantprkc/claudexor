import ClaudexorKit
import Foundation

struct RemoteNativeLoginReadiness: Equatable {
    let nativeSessionVerified: Bool
    let harnessRoutable: Bool

    static func profile(_ entry: CredentialProfileEntry) -> Self {
        let available = entry.status.availability == "available"
        let verified = available && entry.status.verification == "passed"
        return Self(
            nativeSessionVerified: verified,
            harnessRoutable: entry.profile.enabled && verified)
    }
}

/// The installable-harness allowlist — the ONE Swift copy, mirroring the
/// CLI SSOT (`INSTALLABLE_HARNESSES` in
/// packages/cli/src/harness-installer.ts). The remote CLI re-enforces the
/// allowlist itself (usage exit 2 for anything else); this constant only
/// feeds the Settings install menu and the pre-flight guard.
let installableRemoteHarnesses = ["claude", "codex", "cursor", "opencode"]

enum RemoteHarnessInstallVerification: String, Decodable, Equatable, Sendable {
    case releaseVerified = "release_verified"
    case deterministicOnly = "deterministic_only"
    case humanObserved = "human_observed"
}

/// A pending remote harness install, awaiting the user's confirmation. The
/// command/location/pin fields are the remote CLI's own `--dry-run --json`
/// disclosure verbatim (issue #89): the app never re-derives the install
/// command, so the text the user approves is exactly what will run.
struct RemoteHarnessInstallPrompt: Identifiable, Equatable {
    let lease: RemoteActionLease
    let harness: String
    let command: String
    let installLocation: String
    let pinnedVersion: String?
    let verification: RemoteHarnessInstallVerification

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }
}

extension AppModel {
    func startRemoteLogin(
        connectionID: UUID,
        harness: SetupHarness,
        profileID: String? = nil
    ) async {
        let location = ExecutionLocationID.remote(connectionID)
        guard remoteConnections.contains(where: { $0.id == connectionID }),
              let admittedLease = beginRemoteAction(.setupLogin, connectionID: connectionID)
        else { return }
        let transport: SetupJobTransport = harness == .codex ? .daemon : .clientPty
        let terminalPresentation =
            transport == .clientPty
            ? beginRemoteTerminalPresentation(connectionID: connectionID)
            : nil
        // Admit before the first suspension so invocation order, rather than
        // reconnect scheduling order, defines which login is newest.
        remoteDeviceLogin = nil
        if let request = remoteTerminalSheet,
           case .setup = request.purpose
        {
            dismissRemoteTerminal(request)
        }
        retireHarnessProjection(at: location)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let reboundLease = rebindRemoteActionToCurrentGeneration(admittedLease) else {
            if let terminalPresentation {
                finishRemoteTerminalPresentation(terminalPresentation)
            }
            finishRemoteAction(admittedLease)
            return
        }
        guard let connection = remoteConnections.first(where: { $0.id == connectionID }),
              let client = remoteClients[location]
        else {
            if let terminalPresentation {
                finishRemoteTerminalPresentation(terminalPresentation)
            }
            finishRemoteAction(reboundLease)
            return
        }
        let lease = reboundLease
        let setupTarget = RemoteSetupLoginTarget(
            connectionID: connectionID,
            harness: harness.rawValue,
            profileID: profileID,
            transport: transport.rawValue,
            loginFlow: harness == .codex ? "device_auth" : nil)
        beginRemoteSetupJobOwnership(lease: lease, target: setupTarget)
        var createdJobID: String?
        var handedOff = false
        defer {
            if let jobID = finishRemoteSetupJobOwnership(
                lease: lease,
                target: setupTarget,
                createdJobID: createdJobID,
                handedOff: handedOff)
            {
                Task { _ = try? await client.cancelSetupJob(jobId: jobID) }
            }
            if !handedOff, let terminalPresentation {
                finishRemoteTerminalPresentation(terminalPresentation)
            }
        }
        do {
            // Codex device auth remains daemon/API driven. Browser-redirect CLI
            // logins use the same sealed client_pty job as Claude/Cursor.
            let job = try await client.createSetupJob(SetupJobCreateRequest(
                harness: harness,
                action: .login,
                profileId: profileID,
                loginFlow: harness == .codex ? .deviceAuth : nil,
                transport: transport))
            createdJobID = job.jobId
            recordRemoteSetupJob(job.jobId, lease: lease, target: setupTarget)
            guard remoteActionIsCurrent(lease, client: client) else { return }
            if transport == .clientPty {
                guard let terminalPresentation,
                      remoteTerminalPresentationIsCurrent(terminalPresentation)
                else {
                    finishRemoteAction(lease)
                    return
                }
                let invocation = try await sshConnectionManager.setupAttachInvocation(
                    connection, jobID: job.jobId)
                guard remoteActionIsCurrent(lease, client: client),
                      remoteTerminalPresentationIsCurrent(terminalPresentation)
                else {
                    finishRemoteAction(lease)
                    return
                }
                guard presentRemoteTerminal(
                    terminalPresentation,
                    title: "\(harness.rawValue.capitalized) login — \(connection.displayName)",
                    invocation: invocation,
                    purpose: .setup(lease, job.jobId))
                else {
                    finishRemoteAction(lease)
                    return
                }
                handedOff = true
            } else {
                remoteConnectionMessages[connectionID] =
                    "Codex device login started."
                remoteDeviceLogin = RemoteDeviceLoginRequest(
                    lease: lease, jobID: job.jobId)
                handedOff = true
            }
        } catch {
            guard remoteActionIsCurrent(lease, client: client) else { return }
            if let terminalPresentation {
                guard remoteTerminalPresentationIsCurrent(terminalPresentation) else {
                    finishRemoteAction(lease)
                    return
                }
                finishRemoteTerminalPresentation(terminalPresentation)
            }
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
            finishRemoteAction(lease)
        }
    }

    func runRemoteHarnessDoctor(
        connectionID: UUID,
        actionLease: RemoteActionLease? = nil
    ) async {
        let location = ExecutionLocationID.remote(connectionID)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return }
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            isCurrentGateway(client, at: location)
        else {
            if isCurrentGateway(client, at: location),
               actionLease.map({ remoteActionIsCurrent($0, client: client) }) ?? true
            {
                remoteConnectionMessages[connectionID] = "Harness Doctor could not refresh. Retry."
            }
            return
        }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return }
        }
        let harnesses = remoteHarnesses[location] ?? []
        let ready = harnesses.filter { !$0.routableIntents.isEmpty }.count
        remoteConnectionMessages[connectionID] =
            "Harness Doctor: \(ready) of \(harnesses.count) harnesses ready."
    }

    func finishRemoteSetup(_ lease: RemoteActionLease) async {
        guard remoteActionIsCurrent(lease) else { return }
        await runRemoteHarnessDoctor(
            connectionID: lease.connectionID,
            actionLease: lease)
        finishRemoteAction(lease)
    }

    /// Fetch the remote runtime's own install disclosure and surface it for
    /// confirmation. Nothing executes here: the actual installer starts only
    /// from `confirmRemoteHarnessInstall`. A missing runtime or an
    /// unparseable disclosure is a loud typed message, never a silent no-op.
    func startRemoteHarnessInstall(connectionID: UUID, harness: String) async {
        // Both refusals go to threadStatus, the connection-INDEPENDENT
        // surface: a message keyed to a vanished connection would render
        // under a ForEach row that no longer exists — silently.
        guard installableRemoteHarnesses.contains(harness) else {
            threadStatus =
                "\(harness) is not an installable harness; nothing was installed."
            return
        }
        guard remoteConnections.contains(where: { $0.id == connectionID }) else {
            threadStatus = "That connection no longer exists; nothing was installed."
            return
        }
        guard let admittedLease = beginRemoteAction(
            .harnessInstall, connectionID: connectionID)
        else { return }
        // Admit before reconnect so two rapid install requests retain the
        // user's invocation order across suspension.
        remoteHarnessInstallPrompt = nil
        if let purpose = settingsRemoteTerminalSheet?.purpose,
           case .install = purpose
        {
            settingsRemoteTerminalSheet = nil
        }
        retireHarnessProjection(at: .remote(connectionID))
        if remoteClients[.remote(connectionID)] == nil {
            await connectRemote(connectionID)
        }
        guard let reboundLease = rebindRemoteActionToCurrentGeneration(admittedLease) else {
            finishRemoteAction(admittedLease)
            return
        }
        guard let connection = remoteConnections.first(where: { $0.id == connectionID }) else {
            finishRemoteAction(reboundLease)
            return
        }
        let lease = reboundLease
        do {
            let dryRun =
                "~/.claudexor/remote/current/bin/claudexor harness install "
                + SSHCommandFactory.posixQuote(harness) + " --dry-run --json"
            let output = try await sshConnectionManager.execute(
                connection, remoteCommand: dryRun)
            guard remoteActionIsCurrent(lease) else { return }
            guard let prompt = Self.parseHarnessInstallDisclosure(
                output.stdout, lease: lease, harness: harness)
            else {
                remoteConnectionMessages[connectionID] =
                    "The remote runtime did not return an install disclosure for "
                    + "\(harness); nothing was installed."
                finishRemoteAction(lease)
                return
            }
            remoteHarnessInstallPrompt = prompt
        } catch {
            guard remoteActionIsCurrent(lease) else { return }
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
            finishRemoteAction(lease)
        }
    }

    /// The remote CLI's `--dry-run --json` answer is the ONLY source of the
    /// confirmation text. Strict: a non-disclosure payload (ok/dryRun false,
    /// harness mismatch, empty command) yields nil and therefore no install.
    nonisolated static func parseHarnessInstallDisclosure(
        _ data: Data,
        lease: RemoteActionLease,
        harness: String
    ) -> RemoteHarnessInstallPrompt? {
        struct Disclosure: Decodable {
            let ok: Bool
            let dryRun: Bool
            let harness: String
            let command: String
            let installLocation: String
            let pinnedVersion: String?
            let verification: RemoteHarnessInstallVerification
        }
        guard let parsed = try? JSONDecoder().decode(Disclosure.self, from: data),
              parsed.ok, parsed.dryRun, parsed.harness == harness,
              !parsed.command.isEmpty
        else { return nil }
        switch parsed.verification {
        case .releaseVerified, .deterministicOnly:
            guard parsed.pinnedVersion?.trimmingCharacters(
                in: .whitespacesAndNewlines).isEmpty == false
            else { return nil }
        case .humanObserved:
            guard parsed.pinnedVersion == nil else { return nil }
        }
        return RemoteHarnessInstallPrompt(
            lease: lease,
            harness: harness,
            command: parsed.command,
            installLocation: parsed.installLocation,
            pinnedVersion: parsed.pinnedVersion,
            verification: parsed.verification)
    }

    /// Run the CONFIRMED install in the visible embedded PTY. `--yes` is
    /// honest here: the user just approved the remote CLI's own disclosure,
    /// and the CLI prints it again in the terminal before executing.
    func confirmRemoteHarnessInstall(_ prompt: RemoteHarnessInstallPrompt) async {
        guard remoteActionIsCurrent(prompt.lease) else { return }
        if remoteHarnessInstallPrompt?.lease == prompt.lease {
            remoteHarnessInstallPrompt = nil
        }
        guard let connection = remoteConnections.first(where: {
            $0.id == prompt.connectionID
        }) else {
            // threadStatus, not remoteConnectionMessages: the row that would
            // render a per-connection message is exactly what vanished.
            threadStatus = "That connection no longer exists; nothing was installed."
            return
        }
        do {
            let factory = try await sshConnectionManager.factory(for: connection)
            guard remoteActionIsCurrent(prompt.lease) else { return }
            let command =
                "~/.claudexor/remote/current/bin/claudexor harness install "
                + SSHCommandFactory.posixQuote(prompt.harness) + " --yes"
            settingsRemoteTerminalSheet = RemoteTerminalSheetRequest(
                title: "Install \(prompt.harness.capitalized) — \(connection.displayName)",
                invocation: factory.remoteCommand(command, requestTTY: true),
                purpose: .install(prompt.lease, prompt.harness))
        } catch {
            guard remoteActionIsCurrent(prompt.lease) else { return }
            remoteConnectionMessages[prompt.connectionID] = userMessageForRemote(error)
            finishRemoteAction(prompt.lease)
        }
    }

    func finishRemoteHarnessInstall(
        lease: RemoteActionLease,
        harness: String,
        exitCode: Int32
    ) async {
        guard remoteActionIsCurrent(lease) else { return }
        let connectionID = lease.connectionID
        let displayName = harness.capitalized
        guard exitCode == 0 else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer failed with exit code \(exitCode)."
            finishRemoteAction(lease)
            return
        }
        let location = ExecutionLocationID.remote(connectionID)
        guard let client = remoteClients[location] else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but the remote connection is unavailable for Harness Doctor."
            finishRemoteAction(lease)
            return
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            remoteActionIsCurrent(lease, client: client)
        else {
            guard remoteActionIsCurrent(lease, client: client) else { return }
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but Harness Doctor could not refresh. Retry."
            finishRemoteAction(lease)
            return
        }
        guard let result = remoteHarnesses[location]?.first(where: {
            $0.family.rawValue == harness
        }) else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer finished, but Harness Doctor did not return that harness."
            finishRemoteAction(lease)
            return
        }
        let installed = result.readiness.first(where: { $0.id == "installed" })
        if installed?.status != "pass" {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer finished, but Harness Doctor still cannot find it"
                + (installed.flatMap(\.detail).map { ": \($0)" } ?? "") + "."
        } else if !result.routableIntents.isEmpty {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed and ready."
        } else {
            let reason = result.reasons.first ?? "authentication is still required"
            let nextStep =
                harness == "opencode"
                ? "Configure its provider credentials."
                : "Use Login → \(displayName)."
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but is not ready: \(reason). \(nextStep)"
        }
        finishRemoteAction(lease)
    }

    func refreshRemoteNativeLoginReadiness(
        connectionID: UUID,
        harnessID: String,
        profileID: String? = nil,
        actionLease: RemoteActionLease? = nil
    ) async -> RemoteNativeLoginReadiness? {
        let location = ExecutionLocationID.remote(connectionID)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return nil }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
        }
        if let profileID {
            guard let entry = await refreshExactCredentialProfile(
                harnessID: harnessID, profileID: profileID, locationID: location),
                isCurrentGateway(client, at: location)
            else { return nil }
            if let actionLease {
                guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
            }
            let readiness = RemoteNativeLoginReadiness.profile(entry)
            remoteConnectionMessages[connectionID] =
                readiness.nativeSessionVerified && readiness.harnessRoutable
                ? "\(harnessID.capitalized) account is signed in and ready."
                : (entry.status.detail ?? "\(harnessID.capitalized) account is not ready yet.")
            return readiness
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            isCurrentGateway(client, at: location)
        else { return nil }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
        }
        guard let harness = remoteHarnesses[location]?.first(where: {
            $0.family.rawValue == harnessID
        }) else {
            remoteConnectionMessages[connectionID] =
                "Harness Doctor did not return \(harnessID)."
            return nil
        }
        let readiness = RemoteNativeLoginReadiness(
            nativeSessionVerified: harness.nativeSessionReady,
            harnessRoutable: !harness.routableIntents.isEmpty)
        if readiness.nativeSessionVerified && readiness.harnessRoutable {
            remoteConnectionMessages[connectionID] =
                "\(harnessID.capitalized) is signed in and ready."
        } else {
            remoteConnectionMessages[connectionID] =
                harness.reasons.first ?? "\(harnessID.capitalized) is not ready yet."
        }
        return readiness
    }

    func dismissRemoteDeviceLogin(_ request: RemoteDeviceLoginRequest) {
        if remoteDeviceLogin?.lease == request.lease {
            remoteDeviceLogin = nil
        }
        // SwiftUI may clear the item binding before onDisappear. Exact finish
        // is still safe: a stale request cannot retire a replacement token.
        finishRemoteAction(request.lease)
    }

    func dismissRemoteHarnessInstallPrompt(_ prompt: RemoteHarnessInstallPrompt) {
        guard remoteHarnessInstallPrompt?.lease == prompt.lease else { return }
        remoteHarnessInstallPrompt = nil
        finishRemoteAction(prompt.lease)
    }

    @discardableResult
    func acceptRemoteHarnessInstallPrompt(_ prompt: RemoteHarnessInstallPrompt) -> Bool {
        guard remoteActionIsCurrent(prompt.lease),
              remoteHarnessInstallPrompt?.lease == prompt.lease
        else { return false }
        // Transfer ownership to the confirm → terminal → Doctor chain before
        // SwiftUI automatically drives the dialog binding to false.
        remoteHarnessInstallPrompt = nil
        return true
    }

    func installRemoteRuntime(connectionID: UUID) async {
        guard let connection = remoteConnections.first(where: {
            $0.id == connectionID
        }) else { return }
        guard remoteConnectTasks[connectionID] == nil,
              connection.status != .connecting,
              connection.status != .installing
        else {
            remoteConnectionMessages[connectionID] =
                "A connection or runtime installation is already in progress."
            return
        }
        let sourceGeneration = remoteConnectionGenerations[connectionID] ?? 0
        var activationLease: RemoteRuntimeActivationLease?
        setRemoteState(
            connectionID, .installing,
            message: "Downloading and verifying the signed runtime…")
        do {
            try await sshConnectionManager.connectBatch(connection)
            try await remoteRuntimeInstaller.recoverPendingActivation(on: connection)
            let target = try await remoteRuntimeInstaller.detectTarget(on: connection)
            let manifest = try await remoteRuntimeInstaller.loadManifest()
            activationLease = try await remoteRuntimeInstaller.install(
                manifest, target: target, on: connection,
                appVersion: Self.appVersionString())
            guard remoteConnectionGenerations[connectionID] == sourceGeneration,
                  remoteConnections.contains(where: { $0.id == connectionID }),
                  remoteConnectTasks[connectionID] == nil
            else { throw CancellationError() }

            guard let lease = activationLease else {
                throw SSHConnectionError.unavailable(
                    "the runtime activation receipt was lost before commit")
            }
            // Ownership transfers before suspension. The exact reconnect now
            // performs handshake → activation commit → client/projection adopt
            // as one publication transaction, and owns rollback on every exit.
            activationLease = nil
            guard await connectRemoteTransferringActivation(
                connection, lease: lease) != nil
            else { return }
        } catch {
            let failure = await remoteActivationFailure(
                error, lease: activationLease, on: connection)
            activationLease = nil
            let currentGeneration = remoteConnectionGenerations[connectionID] ?? 0
            let mayPublish = currentGeneration == sourceGeneration
                || currentGeneration == sourceGeneration + 1
            if mayPublish,
               remoteConnections.contains(where: { $0.id == connectionID })
            {
                setRemoteState(connectionID, .failed, message: failure.message)
            } else if failure.rollbackFailed {
                threadStatus = failure.message
            }
        }
    }

}
