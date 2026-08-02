import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct SettingsLocationSaveTests {
    @MainActor
    @Test func failedInitialLoadDoesNotMaterializeEditableDefaults() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        model.draftExecutionLocation = remote
        SettingsLocationURLProtocol.handler = { request in
            (
                HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"error":"engine unavailable"}"#.utf8)
            )
        }

        let error = await model.refreshSettings(locationID: remote)

        #expect(error?.contains("Could not load settings") == true)
        #expect(model.remoteSettingsSnapshots[remote] == nil)
        guard case .failed(let message) = model.settingsLoadStates[remote] else {
            Issue.record("failed GET must remain an explicit failed projection")
            return
        }
        #expect(message.contains("Could not load settings"))
        #expect(model.activeSettingsSnapshot == nil)
        #expect(model.activeSettingsLoadState == .failed(message))
    }

    @MainActor
    @Test func hiddenLocationLoadFailureDoesNotPaintTheVisibleLocation() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        model.draftExecutionLocation = .local
        model.settingsStatus = "Visible local status"
        SettingsLocationURLProtocol.handler = { request in
            (
                HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"error":"remote unavailable"}"#.utf8)
            )
        }

        _ = await model.refreshSettings(locationID: remote)

        #expect(model.settingsStatus == "Visible local status")
        guard case .failed = model.settingsLoadStates[remote] else {
            Issue.record("the hidden location must retain its own retryable failure")
            return
        }
    }

    @MainActor
    @Test func newerRefreshOwnsTheProjectionWhenAnOlderRequestSettlesFirst() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        model.draftExecutionLocation = remote
        let calls = SettingsLocationCallCounter()
        let firstArrived = SettingsLocationCallCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        defer { releaseFirst.signal() }
        SettingsLocationURLProtocol.handler = { request in
            calls.increment()
            if calls.count == 1 {
                firstArrived.increment()
                _ = releaseFirst.wait(timeout: .now() + 5)
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(#"{"error":"old failure"}"#.utf8)
                )
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.settingsSnapshotJSON.utf8)
            )
        }

        let old = Task { @MainActor in await model.refreshSettings(locationID: remote) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while firstArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "first settings GET never arrived")
            await Task.yield()
        }
        let newest = Task { @MainActor in await model.refreshSettings(locationID: remote) }
        releaseFirst.signal()

        #expect(await old.value?.contains("context changed") == true)
        #expect(await newest.value == nil)
        #expect(model.settingsLoadStates[remote] == .loaded)
        #expect(model.remoteSettingsSnapshots[remote]?.routing.goal == "economy")
        #expect(model.settingsStatus == nil)
    }

    @MainActor
    @Test func supersededSuccessfulRefreshCannotSurviveTheNewerRefreshFailure() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        model.draftExecutionLocation = remote
        let calls = SettingsLocationCallCounter()
        let firstArrived = SettingsLocationCallCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        defer { releaseFirst.signal() }
        SettingsLocationURLProtocol.handler = { request in
            calls.increment()
            if calls.count == 1 {
                firstArrived.increment()
                _ = releaseFirst.wait(timeout: .now() + 5)
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(Self.settingsSnapshotJSON.utf8)
                )
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"error":"new failure"}"#.utf8)
            )
        }

        let older = Task { @MainActor in await model.refreshSettings(locationID: remote) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while firstArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "first settings GET never arrived")
            await Task.yield()
        }
        let newer = Task { @MainActor in await model.refreshSettings(locationID: remote) }
        releaseFirst.signal()

        #expect(await older.value?.contains("context changed") == true)
        let newestError = await newer.value
        #expect(newestError?.contains("Could not load settings") == true)
        #expect(model.remoteSettingsSnapshots[remote] == nil)
        if let newestError {
            #expect(model.settingsLoadStates[remote] == .failed(newestError))
        }
    }

    @MainActor
    @Test func composerDefaultModelComesFromTheActiveRemoteSettingsSnapshot() throws {
        func snapshot(defaultModel: String) throws -> SettingsSnapshot {
            try JSONDecoder().decode(SettingsSnapshot.self, from: Data(#"""
            {
              "sources": [],
              "routing": {"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},
              "budget": {"paidBudgetPerRun":{"kind":"unlimited"}},
              "runtime": null,
              "harnesses": {"claude":{"enabled":true,"nativeCredentialsEnabled":true,"defaultModel":"\#(defaultModel)","effort":null,"maxTurns":null,"maxRounds":null,"toolsAllow":[],"toolsDeny":[],"fallbackModel":null,"web":"auto","authPreference":"auto","profileLimitAction":"rotate"}},
              "interactionTimeoutMs": 900000
            }
            """#.utf8))
        }

        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let remote = ExecutionLocationID.remote(UUID())
        model.settingsSnapshot = try snapshot(defaultModel: "local-model")
        model.remoteSettingsSnapshots[remote] = try snapshot(defaultModel: "remote-model")

        model.draftExecutionLocation = remote
        #expect(model.activeDefaultModel(for: "claude") == "remote-model")

        model.draftExecutionLocation = .local
        #expect(model.activeDefaultModel(for: "claude") == "local-model")
    }

    @MainActor
    @Test func capturedLocationDoesNotRetargetWhenTheActiveLocationChanges() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SettingsLocationURLProtocol.self]
        let session = URLSession(configuration: config)
        let local = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41001")!, token: "local", session: session)
        let remoteClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41002")!, token: "remote", session: session)
        let model = AppModel(client: local, requestNotificationAuthorization: false)
        let remote = ExecutionLocationID.remote(UUID())
        model.remoteClients[remote] = remoteClient
        model.draftExecutionLocation = .local
        model.settingsStatus = "Visible local status"

        let requestedPorts = SettingsLocationPorts()
        SettingsLocationURLProtocol.handler = { request in
            requestedPorts.append(request.url?.port)
            let body: String
            if request.url?.path.hasSuffix("/harnesses") == true {
                body = #"{"harnesses":[]}"#
            } else {
                body = #"{"sources":[],"routing":{"goal":"economy","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":900000}"#
            }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(body.utf8))
        }

        let capturedGeneration = model.executionLocationGeneration(for: remote)
        let ok = await model.saveSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: capturedGeneration
        )

        #expect(ok)
        #expect(requestedPorts.values.first == 41002)
        #expect(!requestedPorts.values.contains(41001))
        #expect(model.remoteSettingsSnapshots[remote]?.routing.goal == "economy")
        #expect(model.settingsSnapshot == nil)
        #expect(model.settingsStatus == "Visible local status")
    }

    @MainActor
    @Test func localOutageDoesNotRetireACapturedRemoteSettingsTarget() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, requestedPorts) = makeRemoteModel()
        SettingsLocationURLProtocol.handler = successfulSettingsHandler(recording: requestedPorts)
        let captured = model.executionLocationGeneration(for: remote)

        model.enterHardOffline()
        model.settingsStatus = "Visible remote status"
        let result = await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: captured
        )

        #expect(result.succeeded)
        #expect(requestedPorts.values.first == 41002)
        #expect(model.settingsStatus == "Visible remote status")
    }

    @MainActor
    @Test func remoteReconnectRetiresTheOldRemoteSettingsTargetBeforeRequest() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, requestedPorts) = makeRemoteModel()
        SettingsLocationURLProtocol.handler = successfulSettingsHandler(recording: requestedPorts)
        let captured = model.executionLocationGeneration(for: remote)
        model.settingsStatus = "Visible location status"
        let id = try #require(remote.remoteConnectionID)
        model.remoteConnectionGenerations[id, default: 0] += 1

        let result = await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: captured
        )

        #expect(!result.succeeded)
        #expect(requestedPorts.values.isEmpty)
        #expect(model.settingsStatus == "Visible location status")
    }

    @MainActor
    @Test func remoteReconnectRetiresAnOldRemoteSettingsTargetWhileRequestIsInFlight() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, requestedPorts) = makeRemoteModel()
        model.settingsStatus = "Visible location status"
        let requestArrived = SettingsLocationCallCounter()
        let releaseRequest = DispatchSemaphore(value: 0)
        defer { releaseRequest.signal() }
        SettingsLocationURLProtocol.handler = { request in
            requestedPorts.append(request.url?.port)
            requestArrived.increment()
            releaseRequest.wait()
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.settingsSnapshotJSON.utf8)
            )
        }
        let captured = model.executionLocationGeneration(for: remote)
        let save = Task { @MainActor in
            await model.writeSettings(
                SettingsUpdateRequest(routingGoal: "economy"),
                at: remote,
                admittedGeneration: captured
            )
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while requestArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "remote save never reached the stub")
            await Task.yield()
        }

        let id = try #require(remote.remoteConnectionID)
        model.remoteConnectionGenerations[id, default: 0] += 1
        releaseRequest.signal()
        let result = await save.value

        #expect(!result.succeeded)
        #expect(result.failureMessage?.contains("in flight") == true)
        #expect(requestedPorts.values == [41002])
        #expect(model.remoteSettingsSnapshots[remote] == nil)
        #expect(model.settingsStatus == "Visible location status")
    }

    @MainActor
    @Test func acknowledgedSaveSettlesBeforeDerivedHarnessRefreshAndRetirementFencesIt() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        let refreshArrived = SettingsLocationCallCounter()
        let refreshFinished = SettingsLocationCallCounter()
        let settingsWrites = SettingsLocationCallCounter()
        let releaseRefresh = DispatchSemaphore(value: 0)
        defer { releaseRefresh.signal() }
        SettingsLocationURLProtocol.handler = { request in
            let body: String
            if request.url?.path.hasSuffix("/harnesses") == true {
                refreshArrived.increment()
                _ = releaseRefresh.wait(timeout: .now() + 5)
                refreshFinished.increment()
                body = #"{"harnesses":[{"id":"claude","status":"ok","manifest":null}]}"#
            } else {
                settingsWrites.increment()
                body = Self.settingsSnapshotJSON
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(body.utf8)
            )
        }

        let captured = model.executionLocationGeneration(for: remote)
        let resultBox = SettingsLocationResultBox()
        let save = Task { @MainActor in
            let result = await model.writeSettings(
                SettingsUpdateRequest(routingGoal: "economy"),
                at: remote,
                admittedGeneration: captured
            )
            resultBox.value = result
            return result
        }
        let refreshDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while refreshArrived.count == 0 {
            try #require(ContinuousClock.now <= refreshDeadline, "harness refresh never started")
            await Task.yield()
        }
        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while resultBox.value == nil, ContinuousClock.now <= settlementDeadline {
            await Task.yield()
        }

        #expect(resultBox.value == .saved)

        // The derived projection has its own per-location lane. A second POST
        // must not queue behind the blocked readiness GET either.
        let secondSave = Task { @MainActor in
            await model.writeSettings(
                SettingsUpdateRequest(routingGoal: "economy"),
                at: remote,
                admittedGeneration: captured
            )
        }
        let secondWriteDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while settingsWrites.count < 2, ContinuousClock.now <= secondWriteDeadline {
            await Task.yield()
        }
        #expect(settingsWrites.count == 2)
        #expect(await secondSave.value == .saved)

        let id = try #require(remote.remoteConnectionID)
        model.remoteConnectionGenerations[id, default: 0] += 1
        model.remoteClients.removeValue(forKey: remote)
        releaseRefresh.signal()
        #expect(await save.value == .saved)

        let finishDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while refreshFinished.count == 0 {
            try #require(ContinuousClock.now <= finishDeadline, "harness refresh never finished")
            await Task.yield()
        }
        await Task.yield()
        #expect(model.remoteHarnesses[remote] == nil)
    }

    @MainActor
    @Test func acknowledgedSaveExpiresNextUpBeforeAFailingDerivedRefresh() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        model.accountsNextUpAuthorityFresh[remote] = true
        model.remoteHarnessReadinessFresh[remote] = true
        let refreshArrived = SettingsLocationCallCounter()
        let refreshFinished = SettingsLocationCallCounter()
        let releaseRefresh = DispatchSemaphore(value: 0)
        defer { releaseRefresh.signal() }
        SettingsLocationURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/harnesses") == true {
                refreshArrived.increment()
                _ = releaseRefresh.wait(timeout: .now() + 5)
                refreshFinished.increment()
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(#"{"error":"refresh failed"}"#.utf8)
                )
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.settingsSnapshotJSON.utf8)
            )
        }

        let result = await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: model.executionLocationGeneration(for: remote))
        #expect(result == .saved)
        let arrivalDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while refreshArrived.count == 0 {
            try #require(ContinuousClock.now <= arrivalDeadline, "harness refresh never started")
            await Task.yield()
        }

        #expect(model.accountsNextUpAuthorityFresh[remote] == false)
        #expect(model.remoteHarnessReadinessFresh[remote] == true)

        releaseRefresh.signal()
        let finishDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while refreshFinished.count == 0 || model.harnessProjectionLanes[remote]?.task != nil {
            try #require(ContinuousClock.now <= finishDeadline, "failed harness refresh never settled")
            await Task.yield()
        }
        #expect(model.accountsNextUpAuthorityFresh[remote] == false)
        #expect(model.remoteHarnessReadinessFresh[remote] == true)
    }

    @MainActor
    @Test func acknowledgedSaveStillRefreshesHarnessesForTheCurrentContext() async throws {
        defer { SettingsLocationURLProtocol.handler = nil }
        let (model, remote, _) = makeRemoteModel()
        let refreshFinished = SettingsLocationCallCounter()
        SettingsLocationURLProtocol.handler = { request in
            let body: String
            if request.url?.path.hasSuffix("/harnesses") == true {
                refreshFinished.increment()
                body = #"{"harnesses":[{"id":"claude","status":"ok","manifest":null}]}"#
            } else {
                body = Self.settingsSnapshotJSON
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(body.utf8)
            )
        }

        let result = await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: model.executionLocationGeneration(for: remote)
        )
        #expect(result == .saved)

        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while model.remoteHarnesses[remote]?.contains(where: { $0.family == .claude }) != true {
            try #require(ContinuousClock.now <= deadline, "current-context harness refresh did not project")
            await Task.yield()
        }
        #expect(refreshFinished.count == 1)
    }

    @MainActor
    private func makeRemoteModel() -> (AppModel, ExecutionLocationID, SettingsLocationPorts) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SettingsLocationURLProtocol.self]
        let session = URLSession(configuration: config)
        let local = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41001")!, token: "local", session: session)
        let remoteClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41002")!, token: "remote", session: session)
        let model = AppModel(client: local, requestNotificationAuthorization: false)
        let remote = ExecutionLocationID.remote(UUID())
        model.remoteClients[remote] = remoteClient
        return (model, remote, SettingsLocationPorts())
    }

    private func successfulSettingsHandler(
        recording requestedPorts: SettingsLocationPorts
    ) -> (URLRequest) throws -> (HTTPURLResponse, Data) {
        { request in
            requestedPorts.append(request.url?.port)
            let body = request.url?.path.hasSuffix("/harnesses") == true
                ? #"{"harnesses":[]}"#
                : Self.settingsSnapshotJSON
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(body.utf8)
            )
        }
    }

    private static let settingsSnapshotJSON = #"{"sources":[],"routing":{"goal":"economy","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":900000}"#
}

private final class SettingsLocationPorts: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Int] = []
    func append(_ value: Int?) {
        guard let value else { return }
        lock.lock(); storage.append(value); lock.unlock()
    }
    var values: [Int] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }
}

private final class SettingsLocationCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0
    func increment() {
        lock.lock(); storage += 1; lock.unlock()
    }
    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return storage
    }
}

@MainActor
private final class SettingsLocationResultBox {
    var value: SettingsWriteResult?
}

private final class SettingsLocationURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        DispatchQueue.global().async { [self] in
            do {
                guard let handler = Self.handler else { throw URLError(.badServerResponse) }
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}
