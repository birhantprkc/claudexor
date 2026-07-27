import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct RemoteModelsTests {
    @Test func locationIDsKeepDaemonIDsScoped() throws {
        let connection = UUID()
        let remote = ExecutionLocationID.remote(connection)
        #expect(remote.remoteConnectionID == connection)
        #expect(ExecutionLocationID.local.rawValue == "local")
        #expect(ExecutionLocationID(rawValue: "ssh:not-a-uuid") == nil)
        #expect(remote.rawValue.hasPrefix("ssh:"))
    }

    @Test func persistedConnectionContainsNoSecretFields() throws {
        let value = RemoteConnection(sshAlias: "prod", nickname: "Build box")
        let json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        #expect(json.contains("\"sshAlias\":\"prod\""))
        #expect(!json.lowercased().contains("password"))
        #expect(!json.lowercased().contains("token"))
        #expect(!json.lowercased().contains("privatekey"))
    }

    @Test func directoryListingDecodesBoundedDisclosureAndCompatibleOlderRows() throws {
        let current = try JSONDecoder().decode(
            RemoteDirectoryListing.self,
            from: Data(
                #"{"path":"/home/me","home":"/home/me","parent":null,"entries":[],"truncated":true}"#
                    .utf8))
        #expect(current.truncated)

        let older = try JSONDecoder().decode(
            RemoteDirectoryListing.self,
            from: Data(
                #"{"path":"/home/me","home":"/home/me","parent":null,"entries":[]}"#
                    .utf8))
        #expect(!older.truncated)
    }
}
