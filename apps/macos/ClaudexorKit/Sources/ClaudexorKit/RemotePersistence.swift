import Foundation

public enum RemotePersistenceError: Error, LocalizedError {
    case insecureDirectory(String)

    public var errorDescription: String? {
        switch self {
        case let .insecureDirectory(path):
            "Refusing to store remote metadata outside a private directory: \(path)"
        }
    }
}

public struct RemoteConnectionStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport() throws -> RemoteConnectionStore {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        return RemoteConnectionStore(
            fileURL: base.appendingPathComponent("Claudexor/connections.json"))
    }

    public func load() throws -> [RemoteConnection] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        return try JSONDecoder.remoteMetadata.decode(
            [RemoteConnection].self, from: Data(contentsOf: fileURL))
    }

    public func save(_ connections: [RemoteConnection]) throws {
        try secureWrite(
            try JSONEncoder.remoteMetadata.encode(connections),
            to: fileURL)
    }
}

public struct RemoteThreadCacheStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport() throws -> RemoteThreadCacheStore {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        return RemoteThreadCacheStore(
            fileURL: base.appendingPathComponent("Claudexor/remote-threads.json"))
    }

    public func load() throws -> [RemoteThreadCacheEntry] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        return try JSONDecoder.remoteMetadata.decode(
            [RemoteThreadCacheEntry].self, from: Data(contentsOf: fileURL))
    }

    public func save(_ entries: [RemoteThreadCacheEntry]) throws {
        try secureWrite(try JSONEncoder.remoteMetadata.encode(entries), to: fileURL)
    }
}

private extension JSONEncoder {
    static var remoteMetadata: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var remoteMetadata: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private func secureWrite(_ data: Data, to url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    let directoryValues = try directory.resourceValues(
        forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard directoryValues.isDirectory == true,
          directoryValues.isSymbolicLink != true
    else {
        throw RemotePersistenceError.insecureDirectory(directory.path)
    }
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
    guard mode & 0o077 == 0 else {
        throw RemotePersistenceError.insecureDirectory(directory.path)
    }
    if FileManager.default.fileExists(atPath: url.path) {
        let fileValues = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard fileValues.isRegularFile == true,
              fileValues.isSymbolicLink != true
        else {
            throw RemotePersistenceError.insecureDirectory(url.path)
        }
    }
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: url.path)
}
