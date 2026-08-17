import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob {
        var req = request("v2/setup/jobs", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        try Self.requireSuccess(resp, data: data)
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func setupJob(jobId: String) async throws -> SetupJob {
        let (data, resp) = try await session.data(for: setupJobRequest(jobId))
        try Self.requireSuccess(resp, data: data)
        return try Self.decodeSetupJob(data, expectedJobId: jobId)
    }

    public func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot {
        let (data, resp) = try await session.data(
            for: setupJobRequest(jobId, suffix: "snapshot"))
        try Self.requireSuccess(resp, data: data)
        let snapshot = try Self.decoder.decode(SetupJobSnapshot.self, from: data)
        guard snapshot.job.jobId == jobId else {
            throw GatewayError.decoding("setup snapshot does not match its requested job")
        }
        return snapshot
    }

    public func listSetupJobs(
        filter: SetupJobListFilter = SetupJobListFilter()
    ) async throws -> [SetupJob] {
        var query: [URLQueryItem] = []
        if let harness = filter.harness {
            query.append(URLQueryItem(name: "harness", value: harness))
        }
        if let action = filter.action {
            query.append(URLQueryItem(name: "action", value: action))
        }
        if let active = filter.active {
            query.append(URLQueryItem(name: "active", value: active ? "true" : "false"))
        }
        if let limit = filter.limit {
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        let req = request("v2/setup/jobs", method: "GET", queryItems: query)
        let (data, resp) = try await session.data(for: req)
        try Self.requireSuccess(resp, data: data)
        return try Self.decoder.decode(SetupJobListResponse.self, from: data).jobs
    }

    public func cancelSetupJob(jobId: String) async throws -> SetupJob {
        try await mutateSetupJob(jobId, action: "cancel")
    }

    public func reconcileSetupJob(jobId: String) async throws -> SetupJob {
        try await mutateSetupJob(jobId, action: "reconcile")
    }

    public func extendSetupJob(jobId: String) async throws -> SetupJob {
        try await mutateSetupJob(jobId, action: "extend")
    }

    /// One-shot sign-in input for a `url_disclosure_with_input` login: the code
    /// the user pasted, which the daemon writes to the waiting vendor CLI's
    /// stdin. The value is a one-time secret — it is encoded into the body and
    /// nothing here logs it, keeps it, or repeats it in a failure (the daemon's
    /// 409 bodies name the job state, never the value).
    public func submitSetupJobInput(jobId: String, value: String) async throws -> SetupJob {
        var req = setupJobRequest(jobId, suffix: "input", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(SetupJobInputRequest(value: value))
        let (data, resp) = try await session.data(for: req)
        try Self.requireSuccess(resp, data: data)
        return try Self.decodeSetupJob(data, expectedJobId: jobId)
    }

    /// Full-snapshot setup lifecycle stream. Unknown names, malformed payloads,
    /// and buffer loss are protocol failures that force a scoped resnapshot.
    public func setupJobEvents(
        jobId: String, lastEventId: String
    ) -> AsyncThrowingStream<SetupJobEvent, Error> {
        let path = setupJobPath(jobId, suffix: "events")
        let frames = sseFrames(path: path, lastEventId: lastEventId)
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(64)) { continuation in
            let task = Task {
                do {
                    for try await frame in frames {
                        switch frame.event {
                        case "end":
                            continuation.finish()
                            return
                        case "error":
                            throw GatewayError.transport(frame.data)
                        case "setup":
                            guard let data = frame.data.data(using: .utf8) else {
                                throw GatewayError.decoding("setup SSE payload is not UTF-8")
                            }
                            let event = try Self.decoder.decode(SetupJobEvent.self, from: data)
                            guard frame.id == event.cursor else {
                                throw GatewayError.decoding(
                                    "setup SSE id does not match its durable event cursor")
                            }
                            guard event.jobId == jobId else {
                                throw GatewayError.decoding(
                                    "setup SSE event does not match its requested job")
                            }
                            guard try Self.yieldChecked(
                                event, to: continuation, context: "setup SSE")
                            else { return }
                        default:
                            throw GatewayError.decoding(
                                "unknown setup SSE event '\(frame.event)'")
                        }
                    }
                    throw GatewayError.transport(
                        "setup SSE ended without a terminal end event")
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func mutateSetupJob(_ jobId: String, action: String) async throws -> SetupJob {
        let (data, resp) = try await session.data(
            for: setupJobRequest(jobId, suffix: action, method: "POST"))
        try Self.requireSuccess(resp, data: data)
        return try Self.decodeSetupJob(data, expectedJobId: jobId)
    }

    private func setupJobRequest(
        _ jobId: String, suffix: String? = nil, method: String = "GET"
    ) -> URLRequest {
        request(setupJobPath(jobId, suffix: suffix), method: method)
    }

    private func setupJobPath(_ jobId: String, suffix: String? = nil) -> String {
        let escaped = jobId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed) ?? jobId
        return ["v2/setup/jobs", escaped, suffix].compactMap { $0 }.joined(separator: "/")
    }

    private static func decodeSetupJob(_ data: Data, expectedJobId: String) throws -> SetupJob {
        let job = try decoder.decode(SetupJob.self, from: data)
        guard job.jobId == expectedJobId else {
            throw GatewayError.decoding("setup response does not match its requested job")
        }
        return job
    }

    private static func requireSuccess(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(
                status: status, body: String(decoding: data, as: UTF8.self))
        }
    }
}
