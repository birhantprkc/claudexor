import Foundation

/// Stable UI routing key. Server-side thread/run schemas remain location-free;
/// the app combines this id with the daemon-owned id at its transport boundary.
public struct ExecutionLocationID: RawRepresentable, Codable, Sendable, Hashable,
    CustomStringConvertible
{
    public let rawValue: String

    public init?(rawValue: String) {
        guard rawValue == "local" || rawValue.hasPrefix("ssh:") else { return nil }
        if rawValue.hasPrefix("ssh:") {
            guard UUID(uuidString: String(rawValue.dropFirst(4))) != nil else { return nil }
        }
        self.rawValue = rawValue
    }

    public static let local = ExecutionLocationID(rawValue: "local")!

    public static func remote(_ connectionID: UUID) -> ExecutionLocationID {
        ExecutionLocationID(rawValue: "ssh:\(connectionID.uuidString.lowercased())")!
    }

    public var remoteConnectionID: UUID? {
        guard rawValue.hasPrefix("ssh:") else { return nil }
        return UUID(uuidString: String(rawValue.dropFirst(4)))
    }

    public var description: String { rawValue }
}

public enum RemoteConnectionState: String, Codable, Sendable {
    case offline
    case connecting
    case needsInteraction = "needs_interaction"
    case installing
    case connected
    case failed
}

/// Persisted connection metadata. It intentionally contains no key, password,
/// bearer token, ssh-agent state, or terminal history.
public struct RemoteConnection: Codable, Sendable, Identifiable, Equatable {
    public let id: UUID
    public var sshAlias: String
    public var nickname: String?
    public var enabled: Bool
    public var status: RemoteConnectionState
    public var savedProjects: [String]
    public var runtimeVersion: String?
    public var lastConnectedAt: Date?

    public init(
        id: UUID = UUID(),
        sshAlias: String,
        nickname: String? = nil,
        enabled: Bool = true,
        status: RemoteConnectionState = .offline,
        savedProjects: [String] = [],
        runtimeVersion: String? = nil,
        lastConnectedAt: Date? = nil
    ) {
        self.id = id
        self.sshAlias = sshAlias
        self.nickname = nickname
        self.enabled = enabled
        self.status = status
        self.savedProjects = savedProjects
        self.runtimeVersion = runtimeVersion
        self.lastConnectedAt = lastConnectedAt
    }

    public var displayName: String {
        let value = nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? sshAlias : value
    }

    public var locationID: ExecutionLocationID { .remote(id) }
}

/// Memory-only state for one active OpenSSH master and its loopback forward.
public struct ConnectionSession: Sendable, Equatable {
    public let connectionID: UUID
    public var state: RemoteConnectionState
    public var localControlPort: Int?
    public var runtimeVersion: String?
    public var lastError: String?

    public init(
        connectionID: UUID,
        state: RemoteConnectionState = .offline,
        localControlPort: Int? = nil,
        runtimeVersion: String? = nil,
        lastError: String? = nil
    ) {
        self.connectionID = connectionID
        self.state = state
        self.localControlPort = localControlPort
        self.runtimeVersion = runtimeVersion
        self.lastError = lastError
    }
}

public struct LocatedThread: Sendable, Identifiable, Equatable {
    public let locationID: ExecutionLocationID
    public let thread: ThreadSummary

    public init(locationID: ExecutionLocationID, thread: ThreadSummary) {
        self.locationID = locationID
        self.thread = thread
    }

    public var id: String { "\(locationID.rawValue)|\(thread.id)" }
}

public struct LocatedRun: Sendable, Identifiable, Equatable {
    public let locationID: ExecutionLocationID
    public let run: RunSummary

    public init(locationID: ExecutionLocationID, run: RunSummary) {
        self.locationID = locationID
        self.run = run
    }

    public var id: String { "\(locationID.rawValue)|\(run.runId)" }
}

public struct RemoteThreadCacheEntry: Codable, Sendable, Identifiable, Equatable {
    public let locationID: ExecutionLocationID
    public let thread: ThreadSummary
    public let syncedAt: Date

    public init(locationID: ExecutionLocationID, thread: ThreadSummary, syncedAt: Date) {
        self.locationID = locationID
        self.thread = thread
        self.syncedAt = syncedAt
    }

    public var id: String { "\(locationID.rawValue)|\(thread.id)" }
}

public struct RemoteDirectoryEntry: Codable, Sendable, Identifiable, Equatable {
    public let name: String
    public let path: String
    public let kind: String
    public let readable: Bool

    public init(name: String, path: String, kind: String, readable: Bool) {
        self.name = name
        self.path = path
        self.kind = kind
        self.readable = readable
    }

    public var id: String { path }
    public var isDirectory: Bool { kind == "directory" }
}

public struct RemoteDirectoryListing: Codable, Sendable, Equatable {
    public let path: String
    public let home: String
    public let parent: String?
    public let entries: [RemoteDirectoryEntry]
    public let truncated: Bool

    public init(
        path: String,
        home: String,
        parent: String?,
        entries: [RemoteDirectoryEntry],
        truncated: Bool = false
    ) {
        self.path = path
        self.home = home
        self.parent = parent
        self.entries = entries
        self.truncated = truncated
    }

    private enum CodingKeys: String, CodingKey {
        case path, home, parent, entries, truncated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        home = try container.decode(String.self, forKey: .home)
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        entries = try container.decode([RemoteDirectoryEntry].self, forKey: .entries)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}
