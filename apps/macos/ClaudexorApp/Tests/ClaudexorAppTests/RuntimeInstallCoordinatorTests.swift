import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

private let candidateBuildSha = String(repeating: "1", count: 40)
private let previousBuildSha = String(repeating: "2", count: 40)
private let wrongBuildSha = String(repeating: "3", count: 40)
private let testBundledSelection = LocalRuntimeClosureSelection(
    scriptURL: URL(fileURLWithPath: "/bundled/claudexord.bundle.cjs"),
    authority: .bundledStampedProbe)
private let testInstallLifecycleOwner = LocalRuntimeLifecycleOwner()

// Deterministic OFFLINE install + rollback drill (D-2, item 6): a fixture closure
// is served from local disk (no network, no real daemon). The whole sequence —
// download → sha-verify → unpack → probe → idle-gate → stop → atomic swap →
// relaunch → handshake → rollback — runs against injected ports.

// MARK: - Stubs

private final class LocalTransport: RuntimeReleaseTransport, @unchecked Sendable {
    let payload: Data
    init(_ payload: Data) { self.payload = payload }
    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        ReleaseFetchResult(status: 200, etag: nil, data: Data())
    }
    func downloadAsset(from url: URL) async throws -> Data { payload }
}

private final class PhaseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var phases: [RuntimeInstallPhase] = []
    func record(_ p: RuntimeInstallPhase) { lock.withLock { phases.append(p) } }
    func contains(_ p: RuntimeInstallPhase) -> Bool { lock.withLock { phases.contains(p) } }
}

private struct StubStartError: Error {}

private enum StubReplacementStopResult {
    case stopped
    case busy
    case activityUnknown
    case failed
}

private actor RuntimeLifecycleTestGate {
    private var entered = false
    private var open = false
    private var entranceWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func pause() async {
        entered = true
        let waiters = entranceWaiters
        entranceWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        guard !open else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { entranceWaiters.append($0) }
    }

    func release() {
        open = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}

private final class StubDaemon: RuntimeDaemonControl, @unchecked Sendable {
    private let lock = NSLock()
    var busy: Bool? = false
    var probeReturns: String?
    var probeBuildSha: String?
    var handshakeReturns: String?
    var handshakeBuildSha: String?
    var handshakeIdentitySequence: [RuntimeClosureIdentity?]?
    var busyGate: RuntimeLifecycleTestGate?
    /// Return nil from handshakeIdentity() this many times FIRST (simulating a
    /// detached daemon still booting), then `handshakeReturns` — the bounded-poll
    /// boot window.
    var handshakeNilCount = 0
    /// When true, the FIRST start() throws (the relaunch), later starts (rollback)
    /// succeed — the audit-6 relaunch-fails-after-swap case.
    var startThrowsOnce = false
    /// When set, start() throws on exactly the Nth call (1-based) — used to fail
    /// the recovery relaunch while letting the forward relaunch succeed.
    var startThrowsOnCall: Int?
    /// Invoked (outside the lock) whenever stop() is called — a test seam to
    /// mutate filesystem state between the failed forward write and the rollback
    /// restore (e.g. drop a permissions obstruction).
    var onStop: (@Sendable () -> Void)?
    var replacementStopResults: [StubReplacementStopResult] = []
    var stops = 0
    var starts = 0

    func isBusy() async -> Bool? {
        let (value, gate) = lock.withLock { (busy, busyGate) }
        if let gate { await gate.pause() }
        return value
    }
    func stopForRuntimeReplacement() async throws {
        let (hook, result): ((@Sendable () -> Void)?, StubReplacementStopResult) = lock.withLock {
            stops += 1
            let result = replacementStopResults.isEmpty
                ? .stopped : replacementStopResults.removeFirst()
            return (onStop, result)
        }
        hook?()
        switch result {
        case .stopped: break
        case .busy: throw RuntimeReplacementStopError.busy
        case .activityUnknown: throw RuntimeReplacementStopError.activityUnknown
        case .failed: throw StubStartError()
        }
    }
    func start() throws {
        try lock.withLock {
            starts += 1
            if startThrowsOnce && starts == 1 { throw StubStartError() }
            if let n = startThrowsOnCall, starts == n { throw StubStartError() }
        }
    }
    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? {
        lock.withLock {
            guard let version = probeReturns else { return nil }
            return RuntimeClosureIdentity(
                version: version,
                buildSha: probeBuildSha ?? Self.defaultBuildSha(for: version))
        }
    }
    func handshakeIdentity() async -> RuntimeClosureIdentity? {
        lock.withLock {
            if handshakeNilCount > 0 { handshakeNilCount -= 1; return nil }
            if var sequence = handshakeIdentitySequence, !sequence.isEmpty {
                let next = sequence.removeFirst()
                handshakeIdentitySequence = sequence
                return next
            }
            guard let version = handshakeReturns else { return nil }
            return RuntimeClosureIdentity(
                version: version,
                buildSha: handshakeBuildSha ?? Self.defaultBuildSha(for: version))
        }
    }

    private static func defaultBuildSha(for version: String) -> String {
        switch version {
        case "3.2.0": return previousBuildSha
        case "3.4.0": return candidateBuildSha
        default: return wrongBuildSha
        }
    }
}

@Suite(.serialized) struct RuntimeInstallCoordinatorTests {
    private func tempRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-install-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Build a real closure tar.gz whose only entry is claudexord.bundle.cjs, and
    /// return (bytes, sha256hex).
    private func fixtureClosure(_ body: String = "// daemon\n") throws -> (Data, String) {
        let stage = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-stage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try Data(body.utf8).write(to: stage.appendingPathComponent("claudexord.bundle.cjs"))
        let tar = stage.appendingPathComponent("closure.tar.gz")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        p.arguments = ["-czf", tar.path, "-C", stage.path, "claudexord.bundle.cjs"]
        try p.run()
        p.waitUntilExit()
        let bytes = try Data(contentsOf: tar)
        let sha = RuntimeInstaller(root: stage).sha256Hex(bytes)
        return (bytes, sha)
    }

    private func manifest(version: String, sha: String) -> RuntimeManifest {
        RuntimeManifest(
            version: version, sha256: sha, minAppVersion: "2.1.0",
            buildSha: candidateBuildSha)
    }

    private let assetURL = URL(string: "https://example/closure.tar.gz")!

    // MARK: - Happy path

    @Test func installsUnpacksAndSwapsAtomically() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "3.4.0"

        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            rollbackSelection: { testBundledSelection },
            onPhase: { recorder.record($0) })

        let version = try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        #expect(version == "3.4.0")

        // current.json now points at versions/3.4.0 with the build sha stamped.
        let current = try #require(installer.readCurrent())
        #expect(current.version == "3.4.0")
        #expect(current.path == "versions/3.4.0")
        #expect(current.engineSha == candidateBuildSha)
        // The closure is unpacked and resolvable by the launcher.
        #expect(installer.containedDaemonScript(current) != nil)
        // Stop-before-swap, relaunch-after.
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        #expect(recorder.contains(.done(version: "3.4.0")))
    }

    @Test func reconciliationAndInstallShareOneExactSessionLifecycleLease() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "3.4.0"
        let gate = RuntimeLifecycleTestGate()
        daemon.busyGate = gate
        let lifecycle = LocalRuntimeLifecycleOwner()
        let selected = LocalRuntimeClosureSelection(
            scriptURL: URL(fileURLWithPath: "/selected/claudexord.bundle.cjs"),
            authority: .bundledStampedProbe)
        let reconciler = LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: lifecycle,
            targetClosure: { selected },
            handshakePollInterval: 0.001,
            handshakePollTimeout: 0.1)
        let old = RuntimeClosureIdentity(
            version: "3.2.0", buildSha: previousBuildSha)
        let reconciliation = Task { await reconciler.reconcile(serving: old) }
        await gate.waitUntilEntered()

        let coord = RuntimeInstallCoordinator(
            installer: RuntimeInstaller(root: root),
            transport: LocalTransport(Data()),
            daemon: daemon,
            lifecycleOwner: lifecycle)
        await #expect(throws: RuntimeInstallError.lifecycleBusy) {
            try await coord.install(
                manifest: manifest(
                    version: "3.5.0", sha: String(repeating: "0", count: 64)),
                assetURL: assetURL)
        }
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)

        await gate.release()
        let result = await reconciliation.value
        #expect(result == .replaced(RuntimeClosureIdentity(
            version: "3.4.0", buildSha: candidateBuildSha)))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    // MARK: - Failure paths

    @Test func refusesADigestMismatchWithoutSwapping() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, _) = try fixtureClosure()
        let daemon = StubDaemon()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)
        // A manifest whose sha does NOT match the served bytes.
        let bad = manifest(version: "3.4.0", sha: String(repeating: "e", count: 64))
        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: bad, assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)  // never swapped
        #expect(daemon.stops == 0)
    }

    @Test func refusesWhileTheDaemonIsBusy() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.busy = true
        daemon.probeReturns = "3.4.0"
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)
        await #expect(throws: RuntimeInstallError.daemonBusy) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 0)  // never stopped an active daemon
    }

    @Test func atomicStopRefusesWorkAdmittedAfterTheAdvisoryIdleSnapshot() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.busy = false
        daemon.probeReturns = "3.4.0"
        daemon.replacementStopResults = [.busy]
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            rollbackSelection: { testBundledSelection })

        await #expect(throws: RuntimeInstallError.daemonBusy) {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 0)
        #expect(!FileManager.default.fileExists(
            atPath: root.appendingPathComponent("versions/3.4.0").path))
    }

    @Test func refusesBeforeStopWhenExactRollbackAuthorityIsUnavailable() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let legacy = RuntimeCurrent(
            version: "3.2.0",
            path: RuntimeCurrent.versionPath("3.2.0"),
            sha256: String(repeating: "a", count: 64),
            installedAt: "legacy",
            engineSha: nil)
        try installer.writeCurrentAtomic(legacy)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        await #expect(throws: RuntimeInstallError.rollbackIdentityUnavailable) {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == legacy)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func refusesWhenTheProbeVersionMismatches() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "9.9.9"  // wrong
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)
        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 0)
    }

    @Test func refusesWhenProbeVersionMatchesButBuildShaDoesNot() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.probeBuildSha = wrongBuildSha
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        let error = await captureError {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(error as? RuntimeInstallError == .probeMismatch(
            expected: RuntimeClosureIdentity(
                version: "3.4.0", buildSha: candidateBuildSha),
            got: RuntimeClosureIdentity(
                version: "3.4.0", buildSha: wrongBuildSha)))
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 0)
    }

    @Test func refusesAVersionRegression() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Seed a NEWER current pointer.
        try installer.writeCurrentAtomic(
            RuntimeCurrent(
                version: "3.9.0", path: "versions/3.9.0",
                sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil))
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)
        await #expect(throws: RuntimeInstallError.notMonotonic(target: "3.4.0")) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent()?.version == "3.9.0")  // unchanged
    }

    // MARK: - Rollback drill

    @Test func rollsBackToLastKnownGoodOnHandshakeFailure() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Pre-existing installed runtime 3.2.0 (the rollback target).
        let previous = RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old",
            engineSha: previousBuildSha)
        let prevDir = root.appendingPathComponent("versions/3.2.0", isDirectory: true)
        try FileManager.default.createDirectory(at: prevDir, withIntermediateDirectories: true)
        try Data("// prev".utf8).write(to: prevDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrentAtomic(previous)

        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"  // probe OK
        daemon.handshakeReturns = "3.2.0"  // but the relaunched engine is NOT 3.4.0
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        // Rolled BACK: the active pointer is the previous 3.2.0 again.
        let current = try #require(installer.readCurrent())
        #expect(current.version == "3.2.0")
        #expect(current.engineSha == previousBuildSha)
        // The previous runtime was promoted to last-known-good during the swap.
        #expect(installer.readLastKnownGood()?.version == "3.2.0")
        // Stopped for the swap AND again for the rollback; relaunched twice.
        #expect(daemon.stops == 2)
        #expect(daemon.starts == 2)
    }

    @Test func rollsBackWhenHandshakeVersionMatchesButBuildShaDoesNot() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        let wrongCandidate = RuntimeClosureIdentity(
            version: "3.4.0", buildSha: wrongBuildSha)
        daemon.handshakeIdentitySequence = [
            wrongCandidate,
            RuntimeClosureIdentity(version: "3.2.0", buildSha: previousBuildSha),
        ]
        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            onPhase: { recorder.record($0) })

        let error = await captureError {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(error as? RuntimeInstallError == .handshakeMismatch(
            expected: RuntimeClosureIdentity(
                version: "3.4.0", buildSha: candidateBuildSha),
            got: wrongCandidate))
        #expect(installer.readCurrent() == previousPointer())
        #expect(recorder.contains(.rolledBack(reason: "post-relaunch handshake mismatch")))
    }

    @Test func rollbackRefusesToMoveThePointerBeneathACandidateThatAcceptedWork() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeIdentitySequence = [
            RuntimeClosureIdentity(version: "3.4.0", buildSha: wrongBuildSha)
        ]
        daemon.replacementStopResults = [.stopped, .busy]
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        let error = await captureError {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case let .recoveryFailed(step, _) = error as? RuntimeInstallError else {
            Issue.record("expected recoveryFailed when candidate replacement stop is refused")
            return
        }
        #expect(step.contains("stop the active candidate runtime"))
        #expect(installer.readCurrent()?.version == "3.4.0")
        #expect(daemon.stops == 2)
        #expect(daemon.starts == 1)
    }

    @Test func rollsBackWhenRelaunchStartThrowsAfterSwap() async throws {
        // Audit 6: daemon.start() THROWS on the post-swap relaunch. The
        // coordinator must roll back to the previous pointer and end
        // failed-but-safe, never strand the newly-swapped-but-unlaunchable
        // pointer.
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let previous = RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old",
            engineSha: previousBuildSha)
        let prevDir = root.appendingPathComponent("versions/3.2.0", isDirectory: true)
        try FileManager.default.createDirectory(at: prevDir, withIntermediateDirectories: true)
        try Data("// prev".utf8).write(to: prevDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrentAtomic(previous)

        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"  // probe OK → we reach the swap
        // The recovered engine (rollback relaunch on the restored 3.2.0 pointer)
        // reports 3.2.0 — so rollback is PROVEN and ends failed-but-safe.
        daemon.handshakeReturns = "3.2.0"
        daemon.startThrowsOnce = true  // the relaunch throws
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        // Rolled BACK: the active pointer is the previous 3.2.0, engine works.
        let current = try #require(installer.readCurrent())
        #expect(current.version == "3.2.0")
        #expect(current.engineSha == previousBuildSha)
        // start() was attempted for the failed relaunch AND again in rollback.
        #expect(daemon.starts == 2)
    }

    // MARK: - Bounded handshake poll (Fix 1: the boot window)

    /// The relaunched daemon spawns DETACHED and answers nil for a few hundred ms
    /// before it binds its socket. A single-shot handshake read nil → mismatch →
    /// spuriously rolled back EVERY real install. The bounded poll waits it out.
    @Test func installSucceedsWhenTheDaemonBecomesReadyAfterABootDelay() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "3.4.0"
        daemon.handshakeNilCount = 4  // still booting for the first 4 probes
        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            rollbackSelection: { testBundledSelection },
            handshakePollInterval: 0.005, handshakePollTimeout: 5,
            onPhase: { recorder.record($0) })

        let version = try await coord.install(
            manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        #expect(version == "3.4.0")
        #expect(installer.readCurrent()?.version == "3.4.0")
        #expect(recorder.contains(.done(version: "3.4.0")))
        // No rollback despite the initial nil handshakes.
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    /// A boot-window TIMEOUT (the engine never serves) is not laundered into a
    /// silent success — the install throws and never reports `.done`.
    @Test func timesOutWhenTheRelaunchedEngineNeverServes() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = nil  // never answers
        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            rollbackSelection: { testBundledSelection },
            handshakePollInterval: 0.005, handshakePollTimeout: 0.05,
            onPhase: { recorder.record($0) })

        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(!recorder.contains(.done(version: "3.4.0")))
    }

    // MARK: - Rollback verifies recovery (Fix 2)

    @Test func rollbackReportsFailedWhenTheRestoreWriteFails() async throws {
        let root = tempRoot()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "9.9.9"  // step-10 mismatch → rollback
        // stop() runs first in rollback; lock the root so the restore write fails.
        daemon.onStop = { [rootPath = root.path] in
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o500], ofItemAtPath: rootPath)
        }
        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            onPhase: { recorder.record($0) })

        let err = await captureError {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case .recoveryFailed(let step, _)? = (err as? RuntimeInstallError) else {
            Issue.record("expected recoveryFailed, got \(String(describing: err))"); return
        }
        #expect(step.contains("pointer"))
        // A recovery failure is surfaced as .failed, never a green .rolledBack.
        #expect(recorder.phases.contains { if case .failed = $0 { return true }; return false })
        #expect(!recorder.phases.contains { if case .rolledBack = $0 { return true }; return false })
    }

    @Test func rollbackReportsFailedWhenTheRecoveryRelaunchFails() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "9.9.9"  // step-10 mismatch → rollback
        daemon.startThrowsOnCall = 2  // forward relaunch OK; recovery relaunch throws
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        let err = await captureError {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case .recoveryFailed(let step, _)? = (err as? RuntimeInstallError) else {
            Issue.record("expected recoveryFailed, got \(String(describing: err))"); return
        }
        #expect(step.contains("relaunch"))
    }

    @Test func rollbackReportsFailedWhenTheRecoveredEngineReportsAWrongVersion() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        // 9.9.9 is neither the new (3.4.0) nor the previous (3.2.0) version, so the
        // step-10 handshake AND the rollback handshake both mismatch.
        daemon.handshakeReturns = "9.9.9"
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        let err = await captureError {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case .recoveryFailed(let step, _)? = (err as? RuntimeInstallError) else {
            Issue.record("expected recoveryFailed, got \(String(describing: err))"); return
        }
        #expect(step.contains("serving"))
    }

    @Test func rollbackRejectsThePriorVersionWithTheWrongBuildSha() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeIdentitySequence = [
            RuntimeClosureIdentity(version: "3.4.0", buildSha: wrongBuildSha),
            RuntimeClosureIdentity(version: "3.2.0", buildSha: wrongBuildSha),
        ]
        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner,
            onPhase: { recorder.record($0) })

        let error = await captureError {
            try await coord.install(
                manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case .recoveryFailed(let step, _)? = error as? RuntimeInstallError else {
            Issue.record("expected exact recovery failure, got \(String(describing: error))")
            return
        }
        #expect(step.contains("serving"))
        #expect(!recorder.phases.contains {
            if case .rolledBack = $0 { return true }
            return false
        })
    }

    /// The writeCurrentAtomic failure branch: the new pointer never lands, the old
    /// daemon is recovered — but if that RESTART fails the coordinator reports
    /// .recoveryFailed, never suppresses it.
    @Test func pointerWriteFailureReportsRestartFailure() async throws {
        let root = tempRoot()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previousPointer())
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "3.2.0"  // if reached, the recovered engine is previous
        daemon.startThrowsOnce = true  // the sole start() (the recovery relaunch) throws
        // 1st stop = pre-swap → lock the root so the forward pointer write fails;
        // 2nd stop = rollback → unlock so the RESTORE write succeeds, reaching the
        // (failing) recovery relaunch.
        let stops = Counter()
        daemon.onStop = { [rootPath = root.path] in
            let n = stops.next()
            try? FileManager.default.setAttributes(
                [.posixPermissions: n == 1 ? 0o500 : 0o700], ofItemAtPath: rootPath)
        }
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            lifecycleOwner: testInstallLifecycleOwner)

        let err = await captureError {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        guard case .recoveryFailed(let step, _)? = (err as? RuntimeInstallError) else {
            Issue.record("expected recoveryFailed, got \(String(describing: err))"); return
        }
        #expect(step.contains("relaunch"))
        #expect(daemon.stops == 2)  // pre-swap stop + rollback stop
    }

    // MARK: - Helpers

    private func previousPointer() -> RuntimeCurrent {
        RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old",
            engineSha: previousBuildSha)
    }

    private func captureError(_ body: () async throws -> Void) async -> Error? {
        do { try await body(); return nil } catch { return error }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.withLock { n += 1; return n } }
}
