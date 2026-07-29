import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func listHarnessStatus(fresh: Bool = false) async throws -> HarnessListResponse {
        let query = fresh ? [URLQueryItem(name: "fresh", value: "true")] : []
        let req = request("harnesses", method: "GET", queryItems: query)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(HarnessListResponse.self, from: data)
    }

    public func listHarnesses(fresh: Bool = false) async throws -> [HarnessStatus] {
        try await listHarnessStatus(fresh: fresh).harnesses
    }
}
