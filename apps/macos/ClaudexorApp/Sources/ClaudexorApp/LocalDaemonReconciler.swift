import Foundation

enum LocalDaemonReconciliationDeferral: Sendable, Equatable {
    case busy
    case activityUnknown
}

enum LocalDaemonReconciliationFailure: Sendable, Equatable {
    case targetScriptUnavailable
    case targetAuthorityUnavailable
    case targetProbeFailed
    case targetAuthorityMismatch(
        expected: RuntimeClosureIdentity,
        got: RuntimeClosureIdentity)
    case servingIdentityUnavailable
    case stopFailed
    case startFailed
    case postStartMismatch(expected: RuntimeClosureIdentity, got: RuntimeClosureIdentity)
    case postStartUnreachable(expected: RuntimeClosureIdentity)
}

enum LocalDaemonReconciliationResult: Sendable, Equatable {
    case coherent(RuntimeClosureIdentity)
    case replaced(RuntimeClosureIdentity)
    case deferred(
        LocalDaemonReconciliationDeferral,
        serving: RuntimeClosureIdentity,
        target: RuntimeClosureIdentity)
    case deferredForLifecycle
    case failed(LocalDaemonReconciliationFailure)
}

/// The AppModel-facing policy for a reconciliation result. Keeping this
/// reduction beside the lifecycle owner prevents connect and steady-state poll
/// from drifting into subtly different safety decisions.
enum LocalDaemonReconciliationPolicy: Sendable, Equatable {
    /// The protocol-compatible daemon remains usable. A non-nil notice explains
    /// why exact closure coherence could not be established yet.
    case useCompatible(notice: String?)
    /// The reconciler replaced the daemon. Discovery/token/client state must be
    /// reacquired before any daemon-owned projection is hydrated.
    case reconnect
    /// A lifecycle transition began but did not finish with the exact target.
    /// The previous client is no longer safe to use.
    case failOffline(notice: String)

    init(_ result: LocalDaemonReconciliationResult) {
        switch result {
        case .coherent:
            self = .useCompatible(notice: nil)
        case .replaced:
            self = .reconnect
        case .deferred(.busy, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred while work is active.")
        case .deferred(.activityUnknown, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred until active work can be checked.")
        case .deferredForLifecycle:
            // The install chip owns the visible lifecycle status while its exact
            // session lease is held; steady polling remains compatible and quiet.
            self = .useCompatible(notice: nil)
        case .failed(.targetScriptUnavailable), .failed(.targetAuthorityUnavailable),
             .failed(.targetProbeFailed), .failed(.targetAuthorityMismatch(_, _)):
            self = .useCompatible(
                notice: "Could not verify the selected engine runtime; continuing with the compatible running engine.")
        case .failed(.servingIdentityUnavailable):
            self = .useCompatible(
                notice: "Could not verify the running engine build; continuing with its compatible protocol.")
        case .failed(.stopFailed):
            self = .failOffline(
                notice: "Engine refresh could not safely stop the previous engine. Reconnecting.")
        case .failed(.startFailed):
            self = .failOffline(
                notice: "Engine refresh stopped the previous engine but could not start the selected runtime. Reconnecting.")
        case .failed(.postStartMismatch):
            self = .failOffline(
                notice: "The refreshed engine identity did not match the selected runtime. Reconnecting.")
        case .failed(.postStartUnreachable):
            self = .failOffline(
                notice: "The refreshed engine did not come online. Reconnecting.")
        }
    }
}

/// Reconciles the compatible local daemon already serving the app with the
/// exact closure selected by `DaemonLauncher`. Protocol compatibility remains
/// the Gateway's concern; this owner only prevents an app upgrade from silently
/// continuing on stale, app-owned engine bytes.
///
/// The actor coalesces overlapping reconnect polls into one lifecycle change.
/// It never stops a daemon unless exact target probing succeeded and active work
/// was authoritatively reported idle.
actor LocalDaemonReconciler {
    private let daemon: any RuntimeDaemonControl
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let targetClosure: @Sendable () -> LocalRuntimeClosureSelection?
    private let handshakePollInterval: TimeInterval
    private let handshakePollTimeout: TimeInterval
    private var inFlight: Task<LocalDaemonReconciliationResult, Never>?

    init(
        daemon: any RuntimeDaemonControl,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        targetClosure: @escaping @Sendable () -> LocalRuntimeClosureSelection? = {
            DaemonLauncher.resolvedRuntime()
        },
        handshakePollInterval: TimeInterval = 0.5,
        handshakePollTimeout: TimeInterval = 30
    ) {
        self.daemon = daemon
        self.lifecycleOwner = lifecycleOwner
        self.targetClosure = targetClosure
        self.handshakePollInterval = handshakePollInterval
        self.handshakePollTimeout = handshakePollTimeout
    }

    /// `serving` should normally be the identity from the handshake that made
    /// the app consider the local daemon connected. Passing nil asks the port to
    /// re-read discovery and handshake; inability to prove it fails closed.
    func reconcile(serving: RuntimeClosureIdentity? = nil) async -> LocalDaemonReconciliationResult {
        if let inFlight { return await inFlight.value }
        // Exact session admission precedes target resolution and the first await.
        // It excludes RuntimeInstallCoordinator's independent actor from the same
        // stop/start lifecycle rather than relying on a sampled UI boolean.
        guard let lifecycleLease = lifecycleOwner.claim(.reconciliation) else {
            return .deferredForLifecycle
        }

        let daemon = self.daemon
        let targetClosure = self.targetClosure
        let pollInterval = handshakePollInterval
        let pollTimeout = handshakePollTimeout
        let task = Task {
            await Self.perform(
                daemon: daemon, targetClosure: targetClosure, serving: serving,
                handshakePollInterval: pollInterval, handshakePollTimeout: pollTimeout)
        }
        inFlight = task
        let result = await task.value
        inFlight = nil
        lifecycleOwner.release(lifecycleLease)
        return result
    }

    private static func perform(
        daemon: any RuntimeDaemonControl,
        targetClosure: @Sendable () -> LocalRuntimeClosureSelection?,
        serving suppliedServing: RuntimeClosureIdentity?,
        handshakePollInterval: TimeInterval,
        handshakePollTimeout: TimeInterval
    ) async -> LocalDaemonReconciliationResult {
        guard let selected = targetClosure() else { return .failed(.targetScriptUnavailable) }
        let expected: RuntimeClosureIdentity?
        switch selected.authority {
        case .installed(let pointerIdentity):
            guard let pointerIdentity else {
                return .failed(.targetAuthorityUnavailable)
            }
            expected = pointerIdentity
        case .bundledStampedProbe:
            expected = nil
        }
        guard let probed = await daemon.probeIdentity(scriptURL: selected.scriptURL) else {
            return .failed(.targetProbeFailed)
        }
        let target: RuntimeClosureIdentity
        if let expected {
            guard probed == expected else {
                return .failed(.targetAuthorityMismatch(expected: expected, got: probed))
            }
            target = expected
        } else {
            // The bundled script is inside the signed app closure; its stamped
            // exact probe is the authority for this launch target.
            target = probed
        }
        let serving: RuntimeClosureIdentity?
        if let suppliedServing {
            serving = suppliedServing
        } else {
            serving = await daemon.handshakeIdentity()
        }
        guard let serving else {
            return .failed(.servingIdentityUnavailable)
        }
        if serving == target { return .coherent(target) }

        switch await daemon.isBusy() {
        case true:
            return .deferred(.busy, serving: serving, target: target)
        case nil:
            return .deferred(.activityUnknown, serving: serving, target: target)
        case false:
            break
        }

        do {
            try await daemon.stopForRuntimeReplacement()
        } catch RuntimeReplacementStopError.busy {
            return .deferred(.busy, serving: serving, target: target)
        } catch RuntimeReplacementStopError.activityUnknown {
            return .deferred(.activityUnknown, serving: serving, target: target)
        } catch {
            return .failed(.stopFailed)
        }
        do {
            try daemon.start(scriptURL: selected.scriptURL)
        } catch {
            return .failed(.startFailed)
        }

        let deadline = Date().addingTimeInterval(max(0, handshakePollTimeout))
        while true {
            if let running = await daemon.handshakeIdentity() {
                return running == target
                    ? .replaced(target)
                    : .failed(.postStartMismatch(expected: target, got: running))
            }
            if Date() >= deadline { return .failed(.postStartUnreachable(expected: target)) }
            let nanoseconds = UInt64(max(0, handshakePollInterval) * 1_000_000_000)
            if nanoseconds == 0 {
                await Task.yield()
            } else {
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
        }
    }
}
