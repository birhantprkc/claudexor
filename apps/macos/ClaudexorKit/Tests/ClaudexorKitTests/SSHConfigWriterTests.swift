import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct SSHConfigWriterTests {
    private let manager = FileManager.default

    private func makeTempDirectory() throws -> String {
        let path = manager.temporaryDirectory
            .appendingPathComponent("claudexor-sshwriter-\(UUID().uuidString)").path
        try manager.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    private func mode(of path: String) throws -> Int {
        let attributes = try manager.attributesOfItem(atPath: path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    @Test func refusesDuplicateAliasIncludingIncludedFiles() throws {
        let root = try makeTempDirectory()
        let extra = "\(root)/extra.conf"
        let config = "\(root)/config"
        try "Host remote\n  HostName r.internal\n".write(
            toFile: extra, atomically: true, encoding: .utf8)
        try "Include \(extra)\nHost local\n  HostName l.internal\n".write(
            toFile: config, atomically: true, encoding: .utf8)
        let writer = SSHConfigWriter()
        #expect(throws: SSHConfigWriteError.duplicateAlias("local", existingSource: config)) {
            try writer.appendHost(
                SSHHostDraft(alias: "local", hostName: "x"), toConfigAt: config)
        }
        // Include-reachable aliases count too — never a silent duplicate.
        #expect(throws: SSHConfigWriteError.duplicateAlias("remote", existingSource: extra)) {
            try writer.appendHost(
                SSHHostDraft(alias: "remote", hostName: "x"), toConfigAt: config)
        }
    }

    @Test func refusesPatternAndWhitespaceAliases() throws {
        let config = try makeTempDirectory() + "/config"
        let writer = SSHConfigWriter()
        for alias in ["prod*", "prod?", "a[1]", "!deny", "-oProxyCommand=x", "two words", ""] {
            #expect(throws: SSHConfigWriteError.invalidAlias(alias)) {
                try writer.appendHost(
                    SSHHostDraft(alias: alias, hostName: "x"), toConfigAt: config)
            }
        }
    }

    @Test func refusesNewlineInjectionInEveryField() throws {
        let config = try makeTempDirectory() + "/config"
        let writer = SSHConfigWriter()
        let forged = "me\nProxyCommand curl evil"
        #expect(throws: SSHConfigWriteError.unsafeValue(field: "Host name")) {
            try writer.appendHost(
                SSHHostDraft(alias: "a", hostName: "h\nHost evil"), toConfigAt: config)
        }
        #expect(throws: SSHConfigWriteError.unsafeValue(field: "User")) {
            try writer.appendHost(
                SSHHostDraft(alias: "a", hostName: "h", user: forged), toConfigAt: config)
        }
        #expect(throws: SSHConfigWriteError.unsafeValue(field: "Identity file")) {
            try writer.appendHost(
                SSHHostDraft(alias: "a", hostName: "h", identityFile: "/k\n Port 1"),
                toConfigAt: config)
        }
        #expect(throws: SSHConfigWriteError.emptyHostName) {
            try writer.appendHost(SSHHostDraft(alias: "a"), toConfigAt: config)
        }
    }

    @Test func refusesBadPorts() throws {
        let config = try makeTempDirectory() + "/config"
        let writer = SSHConfigWriter()
        for port in ["0", "65536", "22a", "-1"] {
            #expect(throws: SSHConfigWriteError.invalidPort(port)) {
                try writer.appendHost(
                    SSHHostDraft(alias: "a", hostName: "h", port: port), toConfigAt: config)
            }
        }
    }

    @Test func appendsWithoutRewritingExistingBytesOrMode() throws {
        let config = try makeTempDirectory() + "/config"
        let original = "# my config\nHost old\n  HostName old.internal" // no trailing newline
        try original.write(toFile: config, atomically: true, encoding: .utf8)
        try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: config)
        let receipt = try SSHConfigWriter().appendHost(
            SSHHostDraft(alias: "fresh", hostName: "fresh.internal", user: "deploy", port: "2202"),
            toConfigAt: config)
        let written = try String(contentsOfFile: config, encoding: .utf8)
        #expect(written.hasPrefix(original))
        #expect(written.contains("Host fresh\n  HostName fresh.internal\n  User deploy\n  Port 2202\n"))
        // Append-only also means the user's own (looser) mode is left alone.
        #expect(try mode(of: config) == 0o644)
        let backupPath = try #require(receipt.backupPath)
        #expect(try String(contentsOfFile: backupPath, encoding: .utf8) == original)
    }

    @Test func createsMissingDirectoryAndFileWithTightModes() throws {
        let root = try makeTempDirectory()
        let config = "\(root)/ssh/config"
        let receipt = try SSHConfigWriter().appendHost(
            SSHHostDraft(alias: "first", hostName: "first.internal"), toConfigAt: config)
        #expect(try mode(of: "\(root)/ssh") == 0o700)
        #expect(try mode(of: config) == 0o600)
        #expect(receipt.backupPath == nil)
        let written = try String(contentsOfFile: config, encoding: .utf8)
        // Only the directives the user filled in — no empty User/Port lines.
        #expect(!written.contains("User"))
        #expect(!written.contains("Port"))
        #expect(!written.contains("IdentityFile"))
    }

    @Test func writtenHostRoundTripsThroughTheScanner() throws {
        let config = try makeTempDirectory() + "/config"
        try SSHConfigWriter().appendHost(
            SSHHostDraft(
                alias: "round-trip",
                hostName: "rt.internal",
                identityFile: "/Users/some one/.ssh/id_ed25519"),
            toConfigAt: config)
        let hosts = try SSHConfigScanner().scan(path: config)
        #expect(hosts.map(\.alias) == ["round-trip"])
        // The spaced identity path is quoted so OpenSSH reads it as one value.
        let written = try String(contentsOfFile: config, encoding: .utf8)
        #expect(written.contains("IdentityFile \"/Users/some one/.ssh/id_ed25519\"\n"))
    }
}
