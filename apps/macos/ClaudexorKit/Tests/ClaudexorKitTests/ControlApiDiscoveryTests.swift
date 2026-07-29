import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct ControlApiDiscoveryTests {
    private let manager = FileManager.default

    private func makeDaemonDirectory() throws -> URL {
        let root = manager.temporaryDirectory
            .appendingPathComponent("control-discovery-\(UUID().uuidString)")
        try manager.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return root
    }

    @Test func loadsDiscoveryAndTokenThroughPrivateFiles() throws {
        let root = try makeDaemonDirectory()
        defer { try? manager.removeItem(at: root) }
        let token = root.appendingPathComponent("token")
        let discovery = root.appendingPathComponent("control-api.json")
        try Data("test-token\n".utf8).write(to: token)
        let json = """
        {"host":"127.0.0.1","port":9234,"tokenPath":"\(token.path)"}
        """
        try Data(json.utf8).write(to: discovery)
        for file in [token, discovery] {
            try manager.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: file.path)
        }

        let loaded = try ControlApiDiscovery.load(from: discovery)
        #expect(loaded.host == "127.0.0.1")
        #expect(loaded.port == 9234)
        #expect(try loaded.readToken() == "test-token")
    }

    @Test func refusesSymlinkedDiscoveryAndTokenFiles() throws {
        let root = try makeDaemonDirectory()
        defer { try? manager.removeItem(at: root) }
        let target = root.appendingPathComponent("target")
        try Data("{}".utf8).write(to: target)
        try manager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: target.path)
        let link = root.appendingPathComponent("control-api.json")
        try manager.createSymbolicLink(at: link, withDestinationURL: target)

        #expect(throws: SecureLocalFileError.self) {
            try ControlApiDiscovery.load(from: link)
        }

        let tokenLink = root.appendingPathComponent("token")
        try manager.createSymbolicLink(at: tokenLink, withDestinationURL: target)
        let value = ControlApiDiscovery(
            host: "127.0.0.1",
            port: 9234,
            tokenPath: tokenLink.path)
        #expect(throws: SecureLocalFileError.self) {
            try value.readToken()
        }
    }
}
