import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func runApplicability(repoRoot: String) async throws
        -> ControlRunApplicabilityResponse
    {
        let root = repoRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        let req = request(
            "run-applicability",
            method: "GET",
            queryItems: [URLQueryItem(name: "repoRoot", value: root)])
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(
                status: status, body: String(decoding: data, as: UTF8.self))
        }
        let result = try Self.decoder.decode(ControlRunApplicabilityResponse.self, from: data)
        guard result.repoRoot == root else {
            throw GatewayError.decoding("run-applicability response root does not match its request")
        }
        return result
    }
}
