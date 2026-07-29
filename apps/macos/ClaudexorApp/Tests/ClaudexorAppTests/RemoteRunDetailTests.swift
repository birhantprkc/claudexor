import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite(.serialized) struct RemoteRunDetailTests {
    @MainActor
    @Test func failedRemoteDetailLoadRemainsRetryable() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let calls = RemoteRunDetailCounter()
        let (model, locationID) = makeModel(runId: "run-retry")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retry" else {
                throw RemoteRunDetailError.badRequest
            }
            if calls.incrementAndGet() == 1 {
                return (response(for: request, status: 503), Data("offline".utf8))
            }
            let body = #"{"summary":{"runId":"run-retry","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"fresh answer","truncated":false},"lastSeq":2}"#
            return (response(for: request), Data(body.utf8))
        }

        #expect(!(await model.loadRunDetail("run-retry", locationID: locationID)))
        #expect(model.task("run-retry", at: locationID)?.engineError?.contains(
            "Could not load run detail") == true)
        #expect(await model.loadRunDetail("run-retry", locationID: locationID))
        #expect(calls.value == 2)
        #expect(model.task("run-retry", at: locationID)?.answerText == "fresh answer")
    }

    @MainActor
    @Test func remoteLegacyDetailUsesTheSharedBoundedArtifactFallback() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-legacy")
        let legacyAnswer = String(repeating: "é", count: 128_001)
        RemoteRunDetailURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/run-legacy":
                let body = #"{"summary":{"runId":"run-legacy","state":"succeeded","mode":"ask"},"artifacts":[{"path":"final/answer.md","kind":"file","bytes":256002}],"lastSeq":3}"#
                return (response(for: request), Data(body.utf8))
            case "/v2/runs/run-legacy/artifacts/final/answer.md":
                return (response(for: request), Data(legacyAnswer.utf8))
            default:
                throw RemoteRunDetailError.badRequest
            }
        }

        #expect(await model.loadRunDetail("run-legacy", locationID: locationID))
        let answer = try #require(model.task("run-legacy", at: locationID)?.answerText)
        let preview = try #require(answer.components(
            separatedBy: "\n\n_Inline preview bounded").first)
        #expect(preview.utf8.count == 256_000)
        #expect(!answer.contains("�"))
        #expect(answer.contains("open final/answer.md for the full artifact"))
    }

    @MainActor
    private func makeModel(runId: String) -> (AppModel, ExecutionLocationID) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemoteRunDetailURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:43123")!, token: "test",
            session: URLSession(configuration: config))
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.selectedExecutionLocation = locationID
        model.draftExecutionLocation = locationID
        model.remoteClients[locationID] = client
        model.remoteTasks[locationID] = [TaskRun(
            id: runId, title: runId, prompt: "", mode: .agent, phase: .succeeded,
            project: "Remote", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])]
        return (model, locationID)
    }
}

private enum RemoteRunDetailError: Error { case badRequest }

private final class RemoteRunDetailCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func incrementAndGet() -> Int { lock.withLock { count += 1; return count } }
}

private func response(for request: URLRequest, status: Int = 200) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
}

private final class RemoteRunDetailURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw RemoteRunDetailError.badRequest }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
