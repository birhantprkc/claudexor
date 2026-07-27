import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct RemotePersistenceTests {
    @Test func connectionFileIsPrivateAndRoundTrips() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("remote-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = RemoteConnectionStore(fileURL: root.appendingPathComponent("connections.json"))
        let expected = [RemoteConnection(sshAlias: "prod", nickname: "Production")]
        try store.save(expected)
        #expect(try store.load() == expected)
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func refusesASymlinkedMetadataDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("remote-store-link-\(UUID().uuidString)")
        let target = root.appendingPathComponent("target")
        let link = root.appendingPathComponent("Claudexor")
        try FileManager.default.createDirectory(
            at: target,
            withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: link,
            withDestinationURL: target)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = RemoteConnectionStore(
            fileURL: link.appendingPathComponent("connections.json"))
        #expect(throws: RemotePersistenceError.self) {
            try store.save([RemoteConnection(sshAlias: "prod")])
        }
        #expect(
            !FileManager.default.fileExists(
                atPath: target.appendingPathComponent("connections.json").path))
    }
}
