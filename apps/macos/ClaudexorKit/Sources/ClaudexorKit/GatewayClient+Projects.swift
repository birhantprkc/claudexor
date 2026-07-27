import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func listProjects() async throws -> ProjectListResponse {
        let req = request("projects", method: "GET")
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        return try Self.decoder.decode(ProjectListResponse.self, from: data)
    }

    public func registerProject(root: String) async throws -> RegisteredProject {
        try await mutateProject(path: "projects", root: root)
    }

    public func relinkProject(id: String, root: String) async throws -> RegisteredProject {
        try await mutateProject(path: "projects/\(id)/relink", root: root)
    }

    public func listRemoteDirectory(path: String? = nil) async throws -> RemoteDirectoryListing {
        let query = path.map { [URLQueryItem(name: "path", value: $0)] } ?? []
        let req = request("filesystem/directories", method: "GET", queryItems: query)
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        return try Self.decoder.decode(RemoteDirectoryListing.self, from: data)
    }

    public func fetchProjectFile(
        projectID: String,
        relativePath: String
    ) async throws -> (data: Data, contentType: String) {
        let req = request(
            "projects/\(projectID)/file",
            method: "GET",
            queryItems: [URLQueryItem(name: "path", value: relativePath)])
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        let contentType = (resp as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        return (data, contentType)
    }

    private func mutateProject(path: String, root: String) async throws -> RegisteredProject {
        var req = request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(ProjectRootRequest(root: root))
        let (data, resp) = try await session.data(for: req)
        try Self.requireOK(resp, data: data)
        return try Self.decoder.decode(RegisteredProject.self, from: data)
    }

    private static func requireOK(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
    }
}
