import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

private struct ReconciliationTestError: Error {}

private final class DaemonHandshakeURLProtocol: URLProtocol {
    nonisolated(unsafe) static var engine = EngineBuildIdentity(
        version: "3.1.2", sha: String(repeating: "a", count: 40), entry: "/old/daemon.js")

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data: Data
        switch request.url?.path {
        case "/healthz":
            data = Data(#"{"ok":true}"#.utf8)
        case "/v2/handshake":
            let engine = Self.engine
            data = Data(#"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"\#(engine.version)","sha":"\#(engine.sha)","entry":"\#(engine.entry)"}}"#.utf8)
        default:
            client?.urlProtocol(self, didFailWithError: ReconciliationTestError())
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ReconciliationDaemonStub: RuntimeDaemonControl, @unchecked Sendable {
    private let lock = NSLock()
    var busy: Bool? = false
    var targetIdentity: RuntimeClosureIdentity?
    var runningIdentity: RuntimeClosureIdentity?
    var handshakeNilCount = 0
    var busyDelayNanoseconds: UInt64 = 0
    var stopThrows = false
    var replacementStopRefusal: RuntimeReplacementStopError?
    var startThrows = false
    private(set) var busyProbes = 0
    private(set) var stops = 0
    private(set) var starts = 0
    private(set) var startedScripts: [URL] = []
    private(set) var stoppedIdentities: [RuntimeClosureIdentity] = []

    func isBusy() async -> Bool? {
        let delay = lock.withLock { busyProbes += 1; return busyDelayNanoseconds }
        if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
        return lock.withLock { busy }
    }

    func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {
        try lock.withLock {
            stops += 1
            stoppedIdentities.append(expectedIdentity)
            if let replacementStopRefusal { throw replacementStopRefusal }
            if stopThrows { throw ReconciliationTestError() }
        }
    }

    func start() throws {
        try start(scriptURL: URL(fileURLWithPath: "/unused"))
    }

    func start(scriptURL: URL) throws {
        try lock.withLock {
            starts += 1
            startedScripts.append(scriptURL)
            if startThrows { throw ReconciliationTestError() }
        }
    }

    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? {
        lock.withLock { targetIdentity }
    }

    func handshakeIdentity() async -> RuntimeClosureIdentity? {
        lock.withLock {
            if handshakeNilCount > 0 {
                handshakeNilCount -= 1
                return nil
            }
            return runningIdentity
        }
    }

    func setBusy(_ value: Bool?) { lock.withLock { busy = value } }
}

@Suite(.serialized) struct LocalDaemonReconcilerTests {
    private let script = URL(fileURLWithPath: "/selected/claudexord.bundle.cjs")
    private let old = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))

    private func reconciler(
        _ daemon: ReconciliationDaemonStub,
        lifecycleOwner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner(),
        targetClosure: LocalRuntimeClosureSelection? = nil,
        pollInterval: TimeInterval = 0.001,
        pollTimeout: TimeInterval = 0.1
    ) -> LocalDaemonReconciler {
        LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: lifecycleOwner,
            targetClosure: {
                targetClosure ?? LocalRuntimeClosureSelection(
                    scriptURL: script, authority: .bundledStampedProbe)
            },
            handshakePollInterval: pollInterval, handshakePollTimeout: pollTimeout)
    }

    @MainActor
    private func appModel(_ daemon: ReconciliationDaemonStub) -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DaemonHandshakeURLProtocol.self]
        let model = AppModel(
            client: GatewayClient(
                baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
                session: URLSession(configuration: config)),
            requestNotificationAuthorization: false)
        model.health = .connected
        model.localDaemonReconciler = reconciler(
            daemon, lifecycleOwner: model.localRuntimeLifecycleOwner)
        return model
    }

    @Test func exactIdentityIsANoop() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target

        let result = await reconciler(daemon).reconcile(serving: target)

        #expect(result == .coherent(target))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func mismatchWhileIdleStopsStartsSelectedClosureAndPollsExactIdentity() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.handshakeNilCount = 2

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.stoppedIdentities == [old])
        #expect(daemon.starts == 1)
        #expect(daemon.startedScripts == [script])
    }

    @Test func busyDaemonIsDeferredWithoutStopping() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = true

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.busy, serving: old, target: target))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func unknownActivityIsDeferredWithoutStopping() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = nil

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.activityUnknown, serving: old, target: target))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func atomicStopDefersWhenWorkArrivesAfterTheAdvisoryIdleSnapshot() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = false
        daemon.replacementStopRefusal = .busy

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.busy, serving: old, target: target))
        #expect(daemon.busyProbes == 1)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 0)
    }

    @Test func atomicStopMapsALateAuthorityFailureToActivityUnknown() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = false
        daemon.replacementStopRefusal = .activityUnknown

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.activityUnknown, serving: old, target: target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 0)
    }

    @Test func aDeferredMismatchCanReconcileAfterWorkBecomesIdle() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.busy = true
        let sut = reconciler(daemon)

        let deferred = await sut.reconcile(serving: old)
        #expect(deferred == .deferred(.busy, serving: old, target: target))
        daemon.setBusy(false)
        let replaced = await sut.reconcile(serving: old)
        #expect(replaced == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func targetProbeFailureNeverStopsAKnownWorkingDaemon() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = nil

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .failed(.targetProbeFailed))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func selectedInstalledPointerRejectsAProbeWithTheWrongBuildSha() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-selected-runtime-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let selectedDir = root.appendingPathComponent("versions/3.2.0")
        try FileManager.default.createDirectory(
            at: selectedDir, withIntermediateDirectories: true)
        try Data("// selected".utf8).write(
            to: selectedDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrentAtomic(RuntimeCurrent(
            version: target.version,
            path: RuntimeCurrent.versionPath(target.version),
            sha256: String(repeating: "1", count: 64),
            installedAt: "now",
            engineSha: target.buildSha))
        let bundled = root.appendingPathComponent("bundled.cjs")
        try Data("// bundled".utf8).write(to: bundled)
        let selected = try #require(DaemonLauncher.resolvedRuntime(
            installer: installer, bundledDaemon: bundled, bundledVersion: "3.1.0"))
        #expect(selected.authority == .installed(target))

        let daemon = ReconciliationDaemonStub()
        let wrong = RuntimeClosureIdentity(
            version: target.version, buildSha: String(repeating: "c", count: 40))
        daemon.targetIdentity = wrong

        let result = await reconciler(
            daemon, targetClosure: selected).reconcile(serving: old)

        #expect(result == .failed(.targetAuthorityMismatch(
            expected: target, got: wrong)))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func wrongPostStartIdentityFailsWithoutClaimingCoherence() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = old

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .failed(.postStartMismatch(expected: target, got: old)))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func unreachablePostStartIdentityFailsAfterTheBoundedPoll() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = nil

        let result = await reconciler(daemon, pollTimeout: 0.01).reconcile(serving: old)

        #expect(result == .failed(.postStartUnreachable(expected: target)))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func concurrentRequestsCoalesceIntoOneLifecycleTransition() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.busyDelayNanoseconds = 30_000_000
        let sut = reconciler(daemon)

        async let first = sut.reconcile(serving: old)
        async let second = sut.reconcile(serving: old)
        let firstResult = await first
        let secondResult = await second

        #expect([firstResult, secondResult] == [.replaced(target), .replaced(target)])
        #expect(daemon.busyProbes == 1)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func policyKeepsCompatibleOnlyForPreLifecycleFailures() {
        #expect(LocalDaemonReconciliationPolicy(.failed(.targetProbeFailed))
            == .useCompatible(notice: "Could not verify the selected engine runtime; continuing with the compatible running engine."))
        #expect(LocalDaemonReconciliationPolicy(.failed(.servingIdentityUnavailable))
            == .useCompatible(notice: "Could not verify the running engine build; continuing with its compatible protocol."))
        #expect(LocalDaemonReconciliationPolicy(.failed(.startFailed))
            == .failOffline(notice: "Engine refresh stopped the previous engine but could not start the selected runtime. Reconnecting."))
        #expect(LocalDaemonReconciliationPolicy(.replaced(target)) == .reconnect)
    }

    @MainActor
    @Test func appPollKeepsBusyCompatibleDaemonThenRetriesWhenIdle() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = true
        let model = appModel(daemon)

        #expect(await model.pollEngineIdentity())

        #expect(model.engineIdentity?.sha == old.buildSha)
        #expect(model.localDaemonReconciliationNotice
            == "Engine refresh is deferred while work is active.")
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)

        daemon.runningIdentity = target
        daemon.setBusy(false)
        #expect(await model.pollEngineIdentity() == false)
        #expect(model.engineIdentity == nil)
        #expect(model.localDaemonReconciliationNotice == nil)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func appPollReplacementForcesReconnectWithoutPublishingEitherIdentity() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let model = appModel(daemon)
        model.engineIdentity = DaemonHandshakeURLProtocol.engine

        #expect(await model.pollEngineIdentity() == false)

        #expect(model.engineIdentity == nil)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func appPollPostLifecycleMismatchFailsOfflineWithoutPublishing() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = old
        let model = appModel(daemon)

        #expect(await model.pollEngineIdentity() == false)

        #expect(model.engineIdentity == nil)
        #expect(model.localDaemonReconciliationNotice
            == "The refreshed engine identity did not match the selected runtime. Reconnecting.")
    }

    @MainActor
    @Test func appPollSkipsLifecycleWhileRuntimeInstallOwnsIt() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        let model = appModel(daemon)
        let lease = try! #require(
            model.localRuntimeLifecycleOwner.claim(.installation))
        defer { model.localRuntimeLifecycleOwner.release(lease) }
        model.runtimeInstalling = true
        model.runtimeInstallStatus = "Installing…"

        #expect(await model.pollEngineIdentity())

        #expect(model.engineIdentity?.sha == old.buildSha)
        #expect(model.runtimeInstallStatus == "Installing…")
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }
}
