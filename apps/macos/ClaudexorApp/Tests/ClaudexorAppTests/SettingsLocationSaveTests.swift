import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct SettingsLocationSaveTests {
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

        let capturedGeneration = model.settingsGeneration(for: remote)
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
        let captured = model.settingsGeneration(for: remote)

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
        let captured = model.settingsGeneration(for: remote)
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
        SettingsLocationURLProtocol.handler = { request in
            requestedPorts.append(request.url?.port)
            requestArrived.increment()
            _ = releaseRequest.wait(timeout: .now() + 5)
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.settingsSnapshotJSON.utf8)
            )
        }
        let captured = model.settingsGeneration(for: remote)
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
