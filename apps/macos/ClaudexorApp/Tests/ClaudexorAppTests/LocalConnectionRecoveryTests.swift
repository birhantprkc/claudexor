import Foundation
import Testing
@testable import ClaudexorApp

private actor SuspendedRecoveryProbe {
    private var entered = false
    private var released = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        entered = true
        let waiters = enteredWaiters
        enteredWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}

@MainActor
private final class LocalConnectionRecoveryHarness {
    let lifecycleOwner: LocalRuntimeLifecycleOwner
    var generation = 1
    var probeResults: [LocalConnectionProbeResult]
    var pollResults: [Bool]
    var startResults: [Bool]
    var probeOverride: (@MainActor () async -> LocalConnectionProbeResult)?
    var pauseActions: [Int: @MainActor () -> Void] = [:]

    private(set) var prepareCount = 0
    private(set) var probeCount = 0
    private(set) var pollCount = 0
    private(set) var startCount = 0
    private(set) var offlineCount = 0
    private(set) var pauseCount = 0

    init(
        lifecycleOwner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner(),
        probes: [LocalConnectionProbeResult],
        polls: [Bool] = [],
        starts: [Bool] = []
    ) {
        self.lifecycleOwner = lifecycleOwner
        probeResults = probes
        pollResults = polls
        startResults = starts
    }

    func run(generation runGeneration: Int? = nil) async {
        let loop = LocalConnectionRecoveryLoop(
            generation: runGeneration ?? generation,
            currentGeneration: { self.generation },
            lifecycleOwner: lifecycleOwner,
            prepareProbe: { self.prepareCount += 1 },
            probe: { await self.nextProbe() },
            pollConnected: { await self.nextPoll() },
            startDaemon: { self.nextStart() },
            enterOffline: { self.offlineCount += 1 },
            pause: { await self.pause() })
        await loop.run()
    }

    private func nextProbe() async -> LocalConnectionProbeResult {
        probeCount += 1
        if let probeOverride { return await probeOverride() }
        guard !probeResults.isEmpty else {
            generation += 1
            return .unavailable
        }
        return probeResults.removeFirst()
    }

    private func nextPoll() async -> Bool {
        pollCount += 1
        return pollResults.isEmpty ? false : pollResults.removeFirst()
    }

    private func nextStart() -> Bool {
        startCount += 1
        return startResults.isEmpty ? true : startResults.removeFirst()
    }

    private func pause() async {
        pauseCount += 1
        pauseActions.removeValue(forKey: pauseCount)?()
        await Task.yield()
    }
}

@Suite(.serialized) struct LocalConnectionRecoveryTests {
    @MainActor
    @Test func initialUnavailableConsumesAtMostOneLaunch() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable, .unavailable])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.pauseCount == 3)
    }

    @MainActor
    @Test func falseStartConsumesTheAttemptBeforeCallingTheStarter() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable], starts: [false, true])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.offlineCount == 2)
    }

    @MainActor
    @Test func confirmedConnectionThenPollLossGetsOneSuccessorAttempt() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .connected, .unavailable, .unavailable],
            polls: [false])

        await sut.run()

        #expect(sut.startCount == 2)
        #expect(sut.pollCount == 1)
    }

    @MainActor
    @Test func repeatedUnavailablePollsNeverAddAttemptsWithinOneOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: Array(repeating: .unavailable, count: 5))

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.prepareCount == 6)
    }

    @MainActor
    @Test func everySecondConfirmedConnectionRearmsExactlyOneFurtherOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [
                .unavailable,
                .connected, .unavailable,
                .connected, .unavailable, .unavailable,
            ],
            polls: [false, false])

        await sut.run()

        #expect(sut.startCount == 3)
        #expect(sut.pollCount == 2)
    }

    @MainActor
    @Test func reconciliationReconnectSuppressesFallbackUntilConfirmedConnection() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.reconnect, .unavailable, .connected, .unavailable],
            polls: [false])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.probeCount >= 4)
    }

    @MainActor
    @Test func staleGenerationAfterAwaitedProbeCannotLaunchOrPublishOffline() async {
        let gate = SuspendedRecoveryProbe()
        let sut = LocalConnectionRecoveryHarness(probes: [])
        sut.probeOverride = {
            await gate.wait()
            return .unavailable
        }
        let oldGeneration = sut.generation

        let task = Task { await sut.run(generation: oldGeneration) }
        await gate.waitUntilEntered()
        sut.generation += 1
        await gate.release()
        await task.value

        #expect(sut.startCount == 0)
        #expect(sut.offlineCount == 0)
        #expect(sut.pauseCount == 0)
    }

    @MainActor
    @Test func busyLifecycleDefersWithoutConsumingThenLaunchesOnceReleased() async throws {
        let owner = LocalRuntimeLifecycleOwner()
        let busyLease = try #require(owner.claim(.installation))
        let sut = LocalConnectionRecoveryHarness(
            lifecycleOwner: owner,
            probes: [.unavailable, .unavailable, .unavailable])
        sut.pauseActions[1] = { owner.release(busyLease) }

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.probeCount >= 3)
    }

    @MainActor
    @Test func exhaustedAllowanceKeepsPollingAndExternalRecoveryRearmsIt() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable, .connected, .unavailable],
            polls: [false], starts: [false, true])

        await sut.run()

        #expect(sut.startCount == 2)
        #expect(sut.pollCount == 1)
        #expect(sut.prepareCount == 5)
    }

    @MainActor
    @Test func manualReconnectRetiresOldGenerationAndFreshGenerationCanLaunch() async {
        let gate = SuspendedRecoveryProbe()
        let sut = LocalConnectionRecoveryHarness(probes: [])
        sut.probeOverride = {
            await gate.wait()
            return .unavailable
        }
        let oldGeneration = sut.generation

        let oldTask = Task { await sut.run(generation: oldGeneration) }
        await gate.waitUntilEntered()
        sut.generation += 1
        await gate.release()
        await oldTask.value
        #expect(sut.startCount == 0)

        sut.probeOverride = nil
        sut.probeResults = [.unavailable]
        await sut.run(generation: sut.generation)

        #expect(sut.startCount == 1)
    }
}
