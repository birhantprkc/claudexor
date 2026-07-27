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
