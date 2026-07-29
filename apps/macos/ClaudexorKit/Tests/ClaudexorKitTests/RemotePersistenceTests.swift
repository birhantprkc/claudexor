import Darwin
import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct RemotePersistenceTests {
    private let manager = FileManager.default

    private func makePrivateDirectory(_ label: String) throws -> URL {
        let url = manager.temporaryDirectory
            .appendingPathComponent("\(label)-\(UUID().uuidString)")
        try manager.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return url
    }

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

    @Test func loadRefusesSymlinkedMetadataDirectory() throws {
        let root = try makePrivateDirectory("remote-store-load-link")
        let target = root.appendingPathComponent("target")
        let link = root.appendingPathComponent("Claudexor")
        try manager.createDirectory(
            at: target,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let targetStore = RemoteConnectionStore(
            fileURL: target.appendingPathComponent("connections.json"))
        try targetStore.save([RemoteConnection(sshAlias: "substituted")])
        try manager.createSymbolicLink(at: link, withDestinationURL: target)
        defer { try? manager.removeItem(at: root) }

        let store = RemoteConnectionStore(
            fileURL: link.appendingPathComponent("connections.json"))
        #expect(throws: RemotePersistenceError.self) {
            try store.load()
        }
    }

    @Test func bothMetadataStoresRefuseSymlinkedFiles() throws {
        let root = try makePrivateDirectory("remote-store-file-link")
        defer { try? manager.removeItem(at: root) }
        let connectionTarget = root.appendingPathComponent("connection-target.json")
        let threadTarget = root.appendingPathComponent("thread-target.json")
        try Data("[]".utf8).write(to: connectionTarget)
        try Data("[]".utf8).write(to: threadTarget)
        try manager.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: connectionTarget.path)
        try manager.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: threadTarget.path)
        let connectionLink = root.appendingPathComponent("connections.json")
        let threadLink = root.appendingPathComponent("remote-threads.json")
        try manager.createSymbolicLink(at: connectionLink, withDestinationURL: connectionTarget)
        try manager.createSymbolicLink(at: threadLink, withDestinationURL: threadTarget)

        #expect(throws: RemotePersistenceError.self) {
            try RemoteConnectionStore(fileURL: connectionLink).load()
        }
        #expect(throws: RemotePersistenceError.self) {
            try RemoteThreadCacheStore(fileURL: threadLink).load()
        }
    }

    @Test func loadRefusesMetadataWithPublicMode() throws {
        let root = try makePrivateDirectory("remote-store-public-file")
        defer { try? manager.removeItem(at: root) }
        let store = RemoteConnectionStore(fileURL: root.appendingPathComponent("connections.json"))
        try store.save([RemoteConnection(sshAlias: "prod")])
        try manager.setAttributes(
            [.posixPermissions: 0o644], ofItemAtPath: store.fileURL.path)

        #expect(throws: RemotePersistenceError.self) {
            try store.load()
        }
    }

    @Test func loadRefusesMetadataFromAPublicDirectory() throws {
        let root = try makePrivateDirectory("remote-store-public-directory")
        defer { try? manager.removeItem(at: root) }
        let file = root.appendingPathComponent("connections.json")
        try Data("[]".utf8).write(to: file)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)

        #expect(throws: RemotePersistenceError.self) {
            try RemoteConnectionStore(fileURL: file).load()
        }
    }

    @Test func secureReaderRefusesAFileOwnedByAnotherExpectedUser() throws {
        let root = try makePrivateDirectory("remote-store-owner")
        defer { try? manager.removeItem(at: root) }
        let file = root.appendingPathComponent("connections.json")
        try Data("[]".utf8).write(to: file)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)

        #expect(throws: SecureLocalFileError.self) {
            try SecureLocalFile.readPrivateData(
                at: file,
                expectedOwner: geteuid() &+ 1)
        }
    }

    @Test func loadRefusesANonRegularMetadataFile() throws {
        let root = try makePrivateDirectory("remote-store-directory-file")
        defer { try? manager.removeItem(at: root) }
        let file = root.appendingPathComponent("connections.json")
        try manager.createDirectory(
            at: file,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o600])

        #expect(throws: RemotePersistenceError.self) {
            try RemoteConnectionStore(fileURL: file).load()
        }
    }

    @Test func loadRefusesAFifoWithoutBlocking() throws {
        let root = try makePrivateDirectory("remote-store-fifo")
        defer { try? manager.removeItem(at: root) }
        let file = root.appendingPathComponent("connections.json")
        #expect(file.path.withCString { mkfifo($0, 0o600) } == 0)

        #expect(throws: RemotePersistenceError.self) {
            try RemoteConnectionStore(fileURL: file).load()
        }
    }

    @Test func missingStoreStillLoadsAsEmpty() throws {
        let root = manager.temporaryDirectory
            .appendingPathComponent("remote-store-missing-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: root) }

        #expect(try RemoteConnectionStore(
            fileURL: root.appendingPathComponent("connections.json")).load().isEmpty)
    }
}
