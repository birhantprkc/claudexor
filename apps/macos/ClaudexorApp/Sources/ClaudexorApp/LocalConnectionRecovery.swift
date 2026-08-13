import Foundation

enum LocalConnectionProbeResult: Equatable {
    case connected
    case reconnect
    case unavailable
    case retryWithoutLaunch
    case lifecycleFailed
    case superseded
}

/// Owns the bounded local-daemon start allowance for one connection generation.
/// A confirmed connection rearms one later outage; a start attempt consumes the
/// allowance before the synchronous launcher runs. The shared lifecycle lease
/// keeps outage recovery from overlapping installation or reconciliation.
@MainActor
struct LocalConnectionRecoveryLoop {
    private let generation: Int
    private let currentGeneration: @MainActor () -> Int
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let prepareProbe: @MainActor () -> Void
    private let probe: @MainActor () async -> LocalConnectionProbeResult
    private let pollConnected: @MainActor () async -> LocalConnectionProbeResult
    private let startDaemon: @MainActor () -> Bool
    private let enterOffline: @MainActor () -> Void
    private let pause: @MainActor () async -> Void

    init(
        generation: Int,
        currentGeneration: @escaping @MainActor () -> Int,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        prepareProbe: @escaping @MainActor () -> Void,
        probe: @escaping @MainActor () async -> LocalConnectionProbeResult,
        pollConnected: @escaping @MainActor () async -> LocalConnectionProbeResult,
        startDaemon: @escaping @MainActor () -> Bool,
        enterOffline: @escaping @MainActor () -> Void,
        pause: @escaping @MainActor () async -> Void
    ) {
        self.generation = generation
        self.currentGeneration = currentGeneration
        self.lifecycleOwner = lifecycleOwner
        self.prepareProbe = prepareProbe
        self.probe = probe
        self.pollConnected = pollConnected
        self.startDaemon = startDaemon
        self.enterOffline = enterOffline
        self.pause = pause
    }

    func run() async {
        var launchAvailable = true
        while isCurrent {
            prepareProbe()
            let result = await probe()
            // Manual Reconnect advances the generation while discovery or a
            // handshake is suspended. Its predecessor may publish nothing.
            guard isCurrent else { return }

            switch result {
            case .connected:
                launchAvailable = true
                connected: while isCurrent {
                    await pause()
                    guard isCurrent else { return }
                    let pollResult = await pollConnected()
                    guard isCurrent else { return }
                    switch pollResult {
                    case .connected:
                        continue
                    case .unavailable:
                        break connected
                    case .retryWithoutLaunch:
                        break connected
                    case .reconnect:
                        // The reconciler already launched and identity-proved a
                        // successor. The next discovery pass must not launch it
                        // again merely because the old client disconnected.
                        launchAvailable = false
                        break connected
                    case .lifecycleFailed:
                        // A stop/start lifecycle was admitted but did not reach
                        // the exact target. Consume this outage's fallback and
                        // keep polling for external/manual recovery.
                        launchAvailable = false
                        enterOffline()
                        await pause()
                        break connected
                    case .superseded:
                        return
                    }
                }

            case .reconnect:
                // Reconciliation already started and identity-verified the
                // selected closure. Suppress a second fallback start until a
                // later confirmed connection creates a new outage allowance.
                launchAvailable = false

            case .unavailable:
                if launchAvailable,
                    let lease = lifecycleOwner.claim(.outageRecovery)
                {
                    // Consume before start, including a synchronous false.
                    launchAvailable = false
                    let started = startDaemon()
                    lifecycleOwner.release(lease)
                    if started {
                        // Preserve the existing Connecting boot window. A
                        // synchronous launch failure instead publishes Offline.
                        await pause()
                        continue
                    }
                }
                enterOffline()
                await pause()

            case .retryWithoutLaunch:
                // A coalesced predecessor retired before destructive lifecycle
                // admission. Retry discovery without inventing an outage start
                // and without consuming the still-valid allowance.
                await pause()

            case .lifecycleFailed:
                launchAvailable = false
                enterOffline()
                await pause()

            case .superseded:
                return
            }
        }
    }

    private var isCurrent: Bool {
        !Task.isCancelled && generation == currentGeneration()
    }
}
