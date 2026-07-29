import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteRoutingTests {
    private func task(id: String, phase: RunPhase) -> TaskRun {
        TaskRun(
            id: id, title: id, prompt: "", mode: .agent, phase: phase,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
    }

    @MainActor
    @Test func duplicateDaemonRunIdsRemainLocationScoped() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.liveTasks = [task(id: "same-run", phase: .running)]
        model.remoteTasks[locationID] = [task(id: "same-run", phase: .succeeded)]

        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .succeeded)

        model.mutateTask("same-run", at: locationID) { $0.phase = .cancelled }
        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .cancelled)
    }

    @Test func terminalSetupAndInstallAreOneShotBlockingOperations() {
        let id = UUID()
        let setupLease = RemoteActionLease(
            lane: .setupLogin, connectionID: id, generation: 1, token: UUID())
        let installLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: id, generation: 1, token: UUID())
        #expect(RemoteTerminalPurpose.authentication(id, 1).blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.setup(setupLease, "setup-job").blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.install(installLease, "cursor").blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.shell.blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.log.blocksDismissalWhileRunning)
    }

    @Test func installDisclosureParsesOnlyTheRemoteCLIsOwnDryRunAnswer() {
        let id = UUID()
        let lease = RemoteActionLease(
            lane: .harnessInstall, connectionID: id, generation: 3, token: UUID())
        let valid = Data("""
        {"ok": true, "dryRun": true, "harness": "codex",
         "command": "npm install --global --prefix ~/.claudexor/remote/vendor @openai/codex@0.144.1",
         "installLocation": "~/.claudexor/remote/vendor/bin",
         "pinnedVersion": "0.144.1", "verification": "release_verified"}
        """.utf8)
        let prompt = AppModel.parseHarnessInstallDisclosure(
            valid, lease: lease, harness: "codex")
        #expect(prompt?.command.hasSuffix("@openai/codex@0.144.1") == true)
        #expect(prompt?.pinnedVersion == "0.144.1")
        #expect(prompt?.installLocation == "~/.claudexor/remote/vendor/bin")

        let cursor = Data("""
        {"ok": true, "dryRun": true, "harness": "cursor",
         "command": "curl --fail --silent --show-error --location https://cursor.com/install --output x/install.sh && /bin/sh x/install.sh",
         "installLocation": "~/.local/bin", "pinnedVersion": null,
         "verification": "human_observed"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            cursor, lease: lease, harness: "cursor")?.pinnedVersion == nil)

        // Anything that is NOT the CLI's own affirmative dry-run disclosure
        // must yield nil — and therefore no install prompt at all.
        let refused = Data(
            #"{"ok": false, "dryRun": true, "harness": "codex", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            refused, lease: lease, harness: "codex") == nil)
        let mismatched = Data(
            #"{"ok": true, "dryRun": true, "harness": "claude", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            mismatched, lease: lease, harness: "codex") == nil)
        #expect(AppModel.parseHarnessInstallDisclosure(
            Data("not json".utf8), lease: lease, harness: "codex") == nil)

        let obsoleteVerification = Data("""
        {"ok": true, "dryRun": true, "harness": "codex", "command": "x",
         "installLocation": "y", "pinnedVersion": "0.144.1",
         "verification": "npm_registry_integrity"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            obsoleteVerification, lease: lease, harness: "codex") == nil)

        let contradictoryVerification = Data("""
        {"ok": true, "dryRun": true, "harness": "cursor", "command": "x",
         "installLocation": "y", "pinnedVersion": "unexpected",
         "verification": "human_observed"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            contradictoryVerification, lease: lease, harness: "cursor") == nil)
    }

    /// The install guards refuse on a surface that does not need the
    /// connection's own row: a connection deleted between the disclosure
    /// dialog and the confirmation has no ForEach row left to render a
    /// per-connection message, so the refusal goes to threadStatus.
    @MainActor @Test func installGuardRefusalsAndStaleConfirmationAreDistinct() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let vanished = UUID()
        let staleLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: vanished, generation: 0, token: UUID())

        await model.confirmRemoteHarnessInstall(
            RemoteHarnessInstallPrompt(
                lease: staleLease, harness: "codex",
                command: "npm install --global x", installLocation: "~/.claudexor",
                pinnedVersion: "0.144.1", verification: .releaseVerified))
        // A completion retired by explicit removal is inert. The direct start
        // guard below remains loud because it is a new user action.
        #expect(model.threadStatus == nil)
        #expect(model.remoteConnectionMessages[vanished] == nil)

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "codex")
        #expect(model.threadStatus == "That connection no longer exists; nothing was installed.")

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "not-a-harness")
        #expect(
            model.threadStatus
                == "not-a-harness is not an installable harness; nothing was installed.")
    }

    @Test func onlyConnectionFailuresTriggerRemoteReadReconnect() {
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.cannotConnectToHost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.networkConnectionLost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.timedOut)))

        #expect(!isRecoverableRemoteTransportFailure(
            URLError(.cancelled)))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.http(status: 404, body: "")))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.decoding("bad payload")))
    }

    @Test func deviceLoginReconcilesOnlyTheKnownProtocolFalseNegative() {
        #expect(remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .routeMismatch,
            effectiveRoute: .managedAPIKey,
            effectiveSource: .apiKeyEnvironment,
            nativeSessionVerified: true,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: false,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .cancelled,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        let recovered = RemoteDeviceLoginTerminalPresentation(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true)
        #expect(recovered == .readyWithWarning)
        #expect(recovered.label == "Signed in; setup check failed")
        #expect(recovered.label != "Login verified")

        #expect(RemoteDeviceLoginTerminalPresentation(
            jobState: .succeeded,
            selectionReason: nil,
            effectiveRoute: nil,
            effectiveSource: nil,
            nativeSessionVerified: false,
            harnessRoutable: false
        ) == .verified)
    }

    @Test func profileReadinessUsesTheExactProfileAndPollFailureDropsTheCode() throws {
        let entry = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(entry) == .init(
            nativeSessionVerified: true, harnessRoutable: true))

        let failed = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"failed","detail":"wrong account","last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(failed) == .init(
            nativeSessionVerified: false, harnessRoutable: false))

        let job = SetupJob(
            jobId: "device", harness: .codex, action: .login,
            state: .waitingForInput, phase: .awaitingUser,
            message: "waiting", createdAt: "2026-07-29T00:00:00Z",
            profileId: "work")
        let snapshot = SetupJobSnapshot(
            job: job, cursor: "cursor", sequence: 1,
            deviceCode: SetupDeviceCodeDisclosure(
                flow: .chatgptDeviceCode,
                verificationUrl: "https://chatgpt.com/device", userCode: "ABCD-1234"))
        let afterPollFailure = try #require(remoteDeviceLoginSnapshotAfterPollFailure(snapshot))
        #expect(afterPollFailure.job.profileId == "work")
        #expect(afterPollFailure.deviceCode == nil)
    }
}
