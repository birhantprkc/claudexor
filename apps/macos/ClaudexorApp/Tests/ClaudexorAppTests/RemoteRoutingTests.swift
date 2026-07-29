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
        #expect(RemoteTerminalPurpose.authentication(id, 1).blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.setup(id, "setup-job").blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.install(id, "cursor").blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.shell.blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.log.blocksDismissalWhileRunning)
    }

    @Test func installDisclosureParsesOnlyTheRemoteCLIsOwnDryRunAnswer() {
        let id = UUID()
        let valid = Data("""
        {"ok": true, "dryRun": true, "harness": "codex",
         "command": "npm install --global --prefix ~/.claudexor/remote/vendor @openai/codex@0.144.1",
         "installLocation": "~/.claudexor/remote/vendor/bin",
         "pinnedVersion": "0.144.1", "verification": "npm_registry_integrity"}
        """.utf8)
        let prompt = AppModel.parseHarnessInstallDisclosure(
            valid, connectionID: id, harness: "codex")
        #expect(prompt?.command.hasSuffix("@openai/codex@0.144.1") == true)
        #expect(prompt?.pinnedVersion == "0.144.1")
        #expect(prompt?.installLocation == "~/.claudexor/remote/vendor/bin")

        let cursor = Data("""
        {"ok": true, "dryRun": true, "harness": "cursor",
         "command": "curl --fail --silent --show-error --location https://cursor.com/install --output x/install.sh && /bin/sh x/install.sh",
         "installLocation": "~/.local/bin", "pinnedVersion": null,
         "verification": "human_watches_pty"}
        """.utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            cursor, connectionID: id, harness: "cursor")?.pinnedVersion == nil)

        // Anything that is NOT the CLI's own affirmative dry-run disclosure
        // must yield nil — and therefore no install prompt at all.
        let refused = Data(
            #"{"ok": false, "dryRun": true, "harness": "codex", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            refused, connectionID: id, harness: "codex") == nil)
        let mismatched = Data(
            #"{"ok": true, "dryRun": true, "harness": "claude", "command": "x", "installLocation": "y"}"#
                .utf8)
        #expect(AppModel.parseHarnessInstallDisclosure(
            mismatched, connectionID: id, harness: "codex") == nil)
        #expect(AppModel.parseHarnessInstallDisclosure(
            Data("not json".utf8), connectionID: id, harness: "codex") == nil)
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
    }
}
