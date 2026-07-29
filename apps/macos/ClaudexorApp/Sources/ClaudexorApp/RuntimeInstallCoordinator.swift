import Foundation
import ClaudexorKit

// MARK: - Engine-runtime auto-INSTALL coordinator (D-2, 3.1)
//
// Orchestrates the one-click in-place engine update the whole feature is about:
//
//   verify monotonic → download → sha256-verify against the SIGNED manifest →
//   full unpack to versions/<v> → re-verify → strip quarantine → probe-start the
//   unpacked daemon (exact `{version,buildSha}` probe) → idle-gate →
//   identity-proven daemon stop → ATOMIC current.json swap (single rename inside
//   a whole-critical-section lock) → relaunch → handshake-verify → rollback to
//   last-known-good on ANY failure. The bundled runtime stays the final fallback
//   (the launcher already falls back on an invalid/absent pointer).
//
// The daemon-lifecycle side effects (busy signal, identity-proven stop, relaunch,
// probe, handshake) are injected through `RuntimeDaemonControl`, so the entire
// sequence — including rollback — is exercised OFFLINE against a locally-served
// fixture closure with no network and no real daemon.

/// The daemon-lifecycle port the installer drives. Every method is the seam a
/// test stubs; production wires them to the existing daemon machinery.
public struct RuntimeClosureIdentity: Sendable, Equatable {
    public let version: String
    public let buildSha: String

    public init(version: String, buildSha: String) {
        self.version = version
        self.buildSha = buildSha
    }

    static func validated(version: String?, buildSha: String?) -> Self? {
        guard let version, !version.isEmpty,
              let buildSha,
              buildSha.count == 40,
              buildSha.utf8.allSatisfy({
                  (48 ... 57).contains($0) || (97 ... 102).contains($0)
              })
        else { return nil }
        return Self(version: version, buildSha: buildSha)
    }
}

/// One process-local authority for every mutation of the app-owned local daemon
/// lifecycle. The opaque token makes release exact: a stale caller can never
/// clear a newer owner's admission. `claim` is synchronous, so both reconciliation
/// and installation acquire it before their first suspension.
public enum LocalRuntimeLifecycleOperation: Sendable, Equatable {
    case reconciliation
    case installation
}

public struct LocalRuntimeLifecycleLease: Sendable, Equatable {
    fileprivate let id: UUID
    public let operation: LocalRuntimeLifecycleOperation
}

public final class LocalRuntimeLifecycleOwner: @unchecked Sendable {
    private let lock = NSLock()
    private var current: LocalRuntimeLifecycleLease?

    public init() {}

    public func claim(_ operation: LocalRuntimeLifecycleOperation) -> LocalRuntimeLifecycleLease? {
        lock.withLock {
            guard current == nil else { return nil }
            let lease = LocalRuntimeLifecycleLease(id: UUID(), operation: operation)
            current = lease
            return lease
        }
    }

    public func release(_ lease: LocalRuntimeLifecycleLease) {
        lock.withLock {
            guard current == lease else { return }
            current = nil
        }
    }
}

public protocol RuntimeDaemonControl: Sendable {
    /// Are jobs running right now? `true` = busy (refuse), `false` = idle,
    /// `nil` = the daemon could not be asked (treated as busy — fail-closed, we
    /// never stop a daemon whose state we cannot confirm).
    func isBusy() async -> Bool?
    /// Atomically prove the daemon idle, fence every daemon-owned admission
    /// surface, and stop the exact running process. A typed refusal leaves the
    /// daemon serving and every ingress open.
    func stopForRuntimeReplacement() async throws
    /// Relaunch the daemon (DaemonLauncher) against the ACTIVE pointer.
    func start() throws
    /// Relaunch one already-resolved closure. Reconciliation uses this overload
    /// so a concurrent pointer change cannot switch the script between its
    /// exact probe and launch.
    func start(scriptURL: URL) throws
    /// Side-effect-free exact closure identity from `--probe`.
    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity?
    /// Exact identity of the currently serving daemon.
    func handshakeIdentity() async -> RuntimeClosureIdentity?
}

public enum RuntimeReplacementStopError: Error, Sendable, Equatable {
    case busy
    case activityUnknown
}

public extension RuntimeDaemonControl {
    /// Existing installer stubs keep their pointer-based start. Production and
    /// reconciliation-specific stubs override this to bind the selected script.
    func start(scriptURL: URL) throws { try start() }
    /// Exact identity is deliberately unavailable unless a conformer proves it;
    /// lifecycle owners treat nil as failure and never guess from a version.
    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? { nil }
    func handshakeIdentity() async -> RuntimeClosureIdentity? { nil }
}

/// Progress states surfaced to the update chip (honest, per DESIGN_SYSTEM).
public enum RuntimeInstallPhase: Sendable, Equatable {
    case downloading
    case verifying
    case unpacking
    case probing
    case awaitingIdle
    case swapping
    case relaunching
    case done(version: String)
    case rolledBack(reason: String)
    case failed(reason: String)
}

public actor RuntimeInstallCoordinator {
    private let installer: RuntimeInstaller
    private let transport: RuntimeReleaseTransport
    private let daemon: RuntimeDaemonControl
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let rollbackSelection: @Sendable () -> LocalRuntimeClosureSelection?
    private let onPhase: @Sendable (RuntimeInstallPhase) -> Void
    /// Bounded-poll cadence for the post-relaunch handshake. A relaunched daemon
    /// spawns DETACHED and needs seconds to bind its socket + rewrite
    /// control-api.json, so the handshake is polled, never single-shot. Injectable
    /// so tests run the poll fast.
    private let handshakePollInterval: TimeInterval
    private let handshakePollTimeout: TimeInterval

    public init(
        installer: RuntimeInstaller,
        transport: RuntimeReleaseTransport,
        daemon: RuntimeDaemonControl,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        rollbackSelection: @escaping @Sendable () -> LocalRuntimeClosureSelection? = { nil },
        handshakePollInterval: TimeInterval = 0.5,
        handshakePollTimeout: TimeInterval = 30,
        onPhase: @escaping @Sendable (RuntimeInstallPhase) -> Void = { _ in }
    ) {
        self.installer = installer
        self.transport = transport
        self.daemon = daemon
        self.lifecycleOwner = lifecycleOwner
        self.rollbackSelection = rollbackSelection
        self.handshakePollInterval = handshakePollInterval
        self.handshakePollTimeout = handshakePollTimeout
        self.onPhase = onPhase
    }

    /// Install a VERIFIED signed manifest's closure from `assetURL`. The manifest
    /// MUST already have passed `RuntimeManifest.verified` — this coordinator
    /// trusts its `version`/`sha256`/`archiveName` as the signed contract.
    /// Returns the installed version on success; throws on refusal/failure (a
    /// failure after the swap rolls back before throwing).
    @discardableResult
    public func install(manifest: RuntimeManifest, assetURL: URL) async throws -> String {
        // Session admission is the first operation in this async transaction.
        // The filesystem lock protects pointer writers; this exact lease also
        // excludes the steady reconciler's stop/start lifecycle.
        guard let lifecycleLease = lifecycleOwner.claim(.installation) else {
            fail(.failed(reason: "another engine lifecycle action is in progress"))
            throw RuntimeInstallError.lifecycleBusy
        }
        defer { lifecycleOwner.release(lifecycleLease) }

        // Whole check-then-swap critical section is guarded by a lock file so two
        // installers can never race the pointer.
        let lock = try acquireLock()
        defer { releaseLock(lock) }

        // 1. Monotonic anti-replay: strictly newer than current + last-known-good.
        let floors =
            [installer.readCurrent()?.version, installer.readLastKnownGood()?.version]
            .compactMap { $0 }
        guard isMonotonicUpgrade(target: manifest.version, floors: floors) else {
            fail(.failed(reason: "not newer than the installed runtime"))
            throw RuntimeInstallError.notMonotonic(target: manifest.version)
        }

        // 2. Download.
        onPhase(.downloading)
        let bytes = try await transport.downloadAsset(from: assetURL)

        // 3. sha256-verify against the SIGNED digest.
        onPhase(.verifying)
        let actual = installer.sha256Hex(bytes)
        guard actual == manifest.sha256 else {
            fail(.failed(reason: "digest mismatch"))
            throw RuntimeInstallError.shaMismatch(expected: manifest.sha256, actual: actual)
        }

        // 4. Full unpack + re-verify, then strip quarantine (post-verification).
        onPhase(.unpacking)
        let versionDir = try installer.unpack(bytes, version: manifest.version)
        installer.stripQuarantine(at: versionDir)
        let unpackedScript = versionDir.appendingPathComponent("claudexord.bundle.cjs")

        // 5. Probe-start the unpacked daemon: both signed identity fields must
        // match. Version equality alone can bind the pointer to the wrong build.
        onPhase(.probing)
        let expectedCandidate = RuntimeClosureIdentity(
            version: manifest.version, buildSha: manifest.buildSha)
        let probed = await daemon.probeIdentity(scriptURL: unpackedScript)
        guard probed == expectedCandidate else {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "probe identity mismatch"))
            throw RuntimeInstallError.probeMismatch(expected: expectedCandidate, got: probed)
        }

        // 6. Idle-gate: refuse while jobs run (nil state = fail-closed busy).
        onPhase(.awaitingIdle)
        let busy = await daemon.isBusy()
        guard busy == false else {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "engine busy"))
            throw RuntimeInstallError.daemonBusy
        }

        // Snapshot the pre-swap pointer so we can roll back to it verbatim.
        let previous = installer.readCurrent()
        let rollbackExpected = await rollbackIdentity(
            selection: rollbackSelection(), previous: previous)
        guard let rollbackExpected else {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "exact rollback identity unavailable"))
            throw RuntimeInstallError.rollbackIdentityUnavailable
        }

        // 7. Daemon-owned atomic idle proof + admission fence + exact stop. The
        // advisory probe above keeps the common busy path cheap; this call is
        // the authority that closes its admission race.
        do {
            try await daemon.stopForRuntimeReplacement()
        } catch RuntimeReplacementStopError.busy {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "engine became busy before replacement admission"))
            throw RuntimeInstallError.daemonBusy
        } catch RuntimeReplacementStopError.activityUnknown {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "engine activity became unknown before replacement admission"))
            throw RuntimeInstallError.daemonBusy
        }

        // 8. ATOMIC swap: promote the prior pointer to last-known-good, then a
        // single-rename write of the new current.json.
        onPhase(.swapping)
        if let previous { try? installer.writeLastKnownGood(previous) }
        let next = RuntimeCurrent(
            version: manifest.version,
            path: RuntimeCurrent.versionPath(manifest.version),
            sha256: manifest.sha256,
            installedAt: ISO8601DateFormatter().string(from: Date()),
            engineSha: manifest.buildSha)
        do {
            try installer.writeCurrentAtomic(next)
        } catch {
            // The new pointer never landed. The daemon was stopped for the swap,
            // so recover the OLD runtime and PROVE it (restart + expected-identity
            // handshake) before reporting — never claim safety over a dead engine.
            throw await rollbackAndClassify(
                to: previous, reason: "pointer write failed",
                expectedIdentity: rollbackExpected,
                recoveredError: .io("could not write current.json: \(error.localizedDescription)"))
        }

        // 9. Relaunch against the new pointer. If the relaunch THROWS (audit 6),
        // the swap already happened — roll back to the previous pointer and leave
        // a working engine (bundled fallback if there was no previous) rather
        // than stranding a broken pointer.
        onPhase(.relaunching)
        do {
            try daemon.start()
        } catch {
            throw await rollbackAndClassify(
                to: previous, reason: "engine relaunch failed after swap",
                expectedIdentity: rollbackExpected,
                recoveredError: .io(
                    "engine relaunch failed after swap; rolled back to the previous runtime: \(error.localizedDescription)"))
        }

        // 10. Handshake-verify the new engine with a BOUNDED poll: the relaunched
        // daemon boots detached and needs seconds to serve, so a single-shot probe
        // reads nil on essentially every real install. Rollback ONLY on a genuine
        // wrong-identity handshake or a boot-window timeout — never on a not-yet-
        // ready nil.
        switch await pollHandshake(expected: expectedCandidate) {
        case .matched:
            onPhase(.done(version: manifest.version))
            return manifest.version
        case let .mismatch(got):
            throw await rollbackAndClassify(
                to: previous, reason: "post-relaunch handshake mismatch",
                expectedIdentity: rollbackExpected,
                recoveredError: .handshakeMismatch(expected: expectedCandidate, got: got))
        case .unreachable:
            throw await rollbackAndClassify(
                to: previous, reason: "post-relaunch handshake timed out",
                expectedIdentity: rollbackExpected,
                recoveredError: .handshakeMismatch(expected: expectedCandidate, got: nil))
        }
    }

    // MARK: - Handshake poll

    private enum HandshakeProbe: Sendable {
        case matched(RuntimeClosureIdentity)
        case mismatch(RuntimeClosureIdentity)
        case unreachable
    }

    /// Bounded poll of the live handshake after a relaunch. Retries every
    /// `handshakePollInterval` up to `handshakePollTimeout`, reloading discovery
    /// each try (the production probe re-reads ControlApiDiscovery per call). A
    /// `nil` handshake is "not serving YET" and keeps polling; a mismatch is
    /// concluded only on a non-nil wrong exact identity or a timeout.
    private func pollHandshake(expected: RuntimeClosureIdentity) async -> HandshakeProbe {
        let deadline = Date().addingTimeInterval(handshakePollTimeout)
        while true {
            if let running = await daemon.handshakeIdentity() {
                return running == expected ? .matched(running) : .mismatch(running)
            }
            if Date() >= deadline { return .unreachable }
            try? await Task.sleep(nanoseconds: UInt64(max(0, handshakePollInterval) * 1_000_000_000))
        }
    }

    // MARK: - Rollback

    private enum RollbackOutcome: Sendable {
        case recovered
        case failed(step: String, remediation: String)
    }

    /// Run the rollback and map its outcome to the error to throw: a PROVEN
    /// recovery throws the caller's original failure (`recoveredError`); a failed
    /// recovery throws `.recoveryFailed` with the exact step + remediation, so the
    /// thrown error never claims a clean rollback over a broken engine.
    private func rollbackAndClassify(
        to previous: RuntimeCurrent?, reason: String,
        expectedIdentity: RuntimeClosureIdentity,
        recoveredError: RuntimeInstallError
    ) async -> RuntimeInstallError {
        switch await rollback(
            to: previous, expectedIdentity: expectedIdentity, reason: reason)
        {
        case .recovered:
            return recoveredError
        case let .failed(step, remediation):
            return .recoveryFailed(step: step, remediation: remediation)
        }
    }

    /// Restore the previous pointer (or delete it so the launcher falls back to
    /// the bundled runtime), relaunch, and PROVE the recovery with the same
    /// bounded handshake poll — the restored pointer wrote, the daemon relaunched,
    /// and it reports the exact expected prior identity. Only then is `.rolledBack`
    /// emitted. If any step
    /// fails, `.failed` carries the exact step + remediation — never a green
    /// "rolled back" over a dead daemon or a broken pointer.
    private func rollback(
        to previous: RuntimeCurrent?,
        expectedIdentity: RuntimeClosureIdentity,
        reason: String
    ) async -> RollbackOutcome {
        // The candidate may have accepted work after its handshake. Never move
        // the pointer beneath that live process: rollback needs the same atomic
        // idle proof and admission fence as forward activation.
        do {
            try await daemon.stopForRuntimeReplacement()
        } catch {
            return rollbackFailed(
                reason, step: "stop the active candidate runtime before restoring the pointer",
                remediation: "Wait for active work to finish, then retry the update or reopen Claudexor.")
        }

        // 1. Restore (or clear) the active pointer.
        if let previous {
            do {
                try installer.writeCurrentAtomic(previous)
            } catch {
                return rollbackFailed(
                    reason, step: "restore the previous runtime pointer",
                    remediation: "Quit and reopen Claudexor; if it does not recover, reinstall the app.")
            }
        } else {
            installer.removeCurrentPointer()
        }

        // 2. Relaunch on the restored pointer.
        do {
            try daemon.start()
        } catch {
            return rollbackFailed(
                reason, step: "relaunch the engine on the previous runtime",
                remediation: "Quit and reopen Claudexor to restart the engine.")
        }

        // 3. Prove the restored engine is the exact prior closure. A reachable
        // version without its authoritative build SHA is not a recovery proof.
        switch await pollHandshake(expected: expectedIdentity) {
        case .matched:
            onPhase(.rolledBack(reason: reason))
            return .recovered
        case let .mismatch(got):
            return rollbackFailed(
                reason, step: "confirm the previous runtime is serving (engine reported \(got))",
                remediation: "Quit and reopen Claudexor; if the wrong engine keeps serving, reinstall the app.")
        case .unreachable:
            return rollbackFailed(
                reason, step: "reach the engine after relaunch",
                remediation: "Quit and reopen Claudexor to restart the engine.")
        }
    }

    /// Resolve rollback authority from the SAME launch selection used by
    /// DaemonLauncher and steady reconciliation. This matters when a stale/same-
    /// version current.json exists but the newer app bundle is the actual target.
    private func rollbackIdentity(
        selection: LocalRuntimeClosureSelection?,
        previous: RuntimeCurrent?
    ) async -> RuntimeClosureIdentity? {
        if let selection {
            switch selection.authority {
            case .installed(let expected):
                return expected
            case .bundledStampedProbe:
                return await daemon.probeIdentity(scriptURL: selection.scriptURL)
            }
        }
        // Direct coordinator tests and non-app embedders may omit a selection
        // resolver. A valid prior pointer still supplies exact rollback authority.
        if let previous {
            return RuntimeClosureIdentity.validated(
                version: previous.version, buildSha: previous.engineSha)
        }
        return nil
    }

    private func rollbackFailed(_ reason: String, step: String, remediation: String) -> RollbackOutcome {
        onPhase(.failed(reason: "\(reason); recovery failed: could not \(step). \(remediation)"))
        return .failed(step: step, remediation: remediation)
    }

    // MARK: - Lock file (whole critical section)

    private func acquireLock() throws -> Int32 {
        try? installer.ensureLayout()
        let fd = open(installer.lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { throw RuntimeInstallError.io("could not open the install lock") }
        // Non-blocking exclusive lock: a second installer fails fast.
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            throw RuntimeInstallError.lockHeld
        }
        return fd
    }

    private func releaseLock(_ fd: Int32) {
        flock(fd, LOCK_UN)
        close(fd)
    }

    private func fail(_ phase: RuntimeInstallPhase) { onPhase(phase) }
}

/// Swift-side monotonic anti-replay (mirrors @claudexor/util
/// isMonotonicRuntimeUpgrade): the target must be strictly greater than every
/// version the app already trusts.
func isMonotonicUpgrade(target: String, floors: [String]) -> Bool {
    guard let t = SemanticVersion(target) else { return false }
    for floor in floors {
        guard let f = SemanticVersion(floor) else { continue }
        if !(t > f) { return false }
    }
    return true
}
