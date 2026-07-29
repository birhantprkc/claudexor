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

    @Test func refusesDanglingConfigSymlinkWithoutMaterializingItsTarget() throws {
        let root = try makeTempDirectory()
        let config = "\(root)/config"
        let target = "\(root)/missing-target"
        try manager.createSymbolicLink(
            atPath: config,
            withDestinationPath: target)

        #expect(throws: SSHConfigWriteError.self) {
            try SSHConfigWriter().appendHost(
                SSHHostDraft(alias: "prod", hostName: "prod.internal"),
                toConfigAt: config)
        }
        #expect(!manager.fileExists(atPath: target))
    }

    @Test func refusesDanglingConfigDirectorySymlinkWithoutMaterializingItsTarget() throws {
        let root = try makeTempDirectory()
        let directory = "\(root)/ssh"
        let targetDirectory = "\(root)/missing-ssh"
        try manager.createSymbolicLink(
            atPath: directory,
            withDestinationPath: targetDirectory)

        #expect(throws: SSHConfigWriteError.self) {
            try SSHConfigWriter().appendHost(
                SSHHostDraft(alias: "prod", hostName: "prod.internal"),
                toConfigAt: "\(directory)/config")
        }
        #expect(!manager.fileExists(atPath: targetDirectory))
    }

    @Test func liveConfigSymlinkGetsARealSnapshotBackup() throws {
        let root = try makeTempDirectory()
        let target = "\(root)/managed-config"
        let config = "\(root)/config"
        let original = "Host old\n  HostName old.internal\n"
        try original.write(toFile: target, atomically: true, encoding: .utf8)
        try manager.createSymbolicLink(atPath: config, withDestinationPath: target)

        let receipt = try SSHConfigWriter().appendHost(
            SSHHostDraft(alias: "fresh", hostName: "fresh.internal"),
            toConfigAt: config)
        let backup = try #require(receipt.backupPath)
        #expect(try String(contentsOfFile: backup, encoding: .utf8) == original)
        let backupValues = try URL(fileURLWithPath: backup).resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        #expect(backupValues.isRegularFile == true)
        #expect(backupValues.isSymbolicLink != true)
        #expect(try String(contentsOfFile: target, encoding: .utf8).contains("Host fresh\n"))
    }

    @Test func refusesWhenConfigIdentityChangesAfterTheScannedSnapshot() throws {
        let root = try makeTempDirectory()
        let config = "\(root)/config"
        let include = "\(root)/included.conf"
        let replacement = "\(root)/replacement"
        let original = "Include \(include)\nHost old\n  HostName old.internal\n"
        let replacementBytes = "Host replacement\n  HostName replacement.internal\n"
        try original.write(toFile: config, atomically: true, encoding: .utf8)
        try "# included\n".write(toFile: include, atomically: true, encoding: .utf8)
        try replacementBytes.write(toFile: replacement, atomically: true, encoding: .utf8)
        let scanner = SSHConfigScanner(readFile: { path in
            if path == include {
                try FileManager.default.removeItem(atPath: config)
                try FileManager.default.createSymbolicLink(
                    atPath: config,
                    withDestinationPath: replacement)
            }
            return try String(contentsOfFile: path, encoding: .utf8)
        })

        #expect(throws: SSHConfigWriteError.self) {
            try SSHConfigWriter(scanner: scanner).appendHost(
                SSHHostDraft(alias: "fresh", hostName: "fresh.internal"),
                toConfigAt: config)
        }
        #expect(try String(contentsOfFile: replacement, encoding: .utf8) == replacementBytes)
    }

    @Test func refusesWhenConfigContentsChangeInPlaceAfterTheScannedSnapshot() throws {
        let root = try makeTempDirectory()
        let config = "\(root)/config"
        let include = "\(root)/included.conf"
        let original = "Include \(include)\nHost old\n  HostName old.internal\n"
        let replacement = "Host replacement\n  HostName replacement.internal\n"
        try original.write(toFile: config, atomically: true, encoding: .utf8)
        try "# included\n".write(toFile: include, atomically: true, encoding: .utf8)
        let scanner = SSHConfigScanner(readFile: { path in
            if path == include {
                let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: config))
                try handle.truncate(atOffset: 0)
                try handle.write(contentsOf: Data(replacement.utf8))
                try handle.close()
            }
            return try String(contentsOfFile: path, encoding: .utf8)
        })

        #expect(throws: SSHConfigWriteError.self) {
            try SSHConfigWriter(scanner: scanner).appendHost(
                SSHHostDraft(alias: "fresh", hostName: "fresh.internal"),
                toConfigAt: config)
        }
        #expect(try String(contentsOfFile: config, encoding: .utf8) == replacement)
    }

    @Test func previewBytesEqualAppendedBytes() throws {
        let config = try makeTempDirectory() + "/config"
        try "Host old\n  HostName o.internal\n".write(
            toFile: config, atomically: true, encoding: .utf8)
        let writer = SSHConfigWriter(now: { Date(timeIntervalSince1970: 1_785_000_000) })
        let draft = SSHHostDraft(
            alias: "preview", hostName: "p.internal", user: "deploy",
            port: "022", identityFile: "~/.ssh/id_ed25519")
        // ONE formatting owner: the sheet preview (render) and the appended
        // bytes must be identical — and the receipt must carry that block.
        let preview = writer.render(draft)
        let receipt = try writer.appendHost(draft, toConfigAt: config)
        #expect(receipt.appendedBlock == preview)
        let written = try String(contentsOfFile: config, encoding: .utf8)
        #expect(written.hasSuffix(preview))
        // Port normalization ("022" → 22) happens in the shared renderer, so
        // the preview shows exactly what lands in the file.
        #expect(preview.contains("  Port 22\n"))
    }

    @Test func receiptIsHonestAboutBackups() throws {
        let config = try makeTempDirectory() + "/config"
        let writer = SSHConfigWriter()
        // Creating the config: no previous file, so no backup may be claimed.
        let first = try writer.appendHost(
            SSHHostDraft(alias: "first", hostName: "f.internal"), toConfigAt: config)
        #expect(first.createdConfig)
        #expect(first.backupPath == nil)
        // Appending to the now-existing config: a real backup, not "created".
        let second = try writer.appendHost(
            SSHHostDraft(alias: "second", hostName: "s.internal"), toConfigAt: config)
        #expect(!second.createdConfig)
        #expect(second.backupPath != nil)
    }

    @Test func liveFieldErrorsMirrorAppendRules() {
        let empty = SSHHostDraft()
        #expect(SSHConfigWriter.liveFieldError(.alias, draft: empty) == "Alias is required.")
        #expect(SSHConfigWriter.liveFieldError(.hostName, draft: empty) == "Host name is required.")
        // Optional fields are quiet while empty.
        for field in [SSHHostDraftField.user, .port, .identityFile] {
            #expect(SSHConfigWriter.liveFieldError(field, draft: empty) == nil)
        }
        let bad = SSHHostDraft(
            alias: "prod*", hostName: "h\nHost evil", user: "a b",
            port: "65536", identityFile: "/k\"x")
        for field in SSHHostDraftField.allCases {
            #expect(SSHConfigWriter.liveFieldError(field, draft: bad) != nil)
        }
        // A known duplicate warns before the write refuses.
        let dup = SSHHostDraft(alias: "prod", hostName: "h")
        #expect(SSHConfigWriter.liveFieldError(.alias, draft: dup, knownAliases: ["prod"]) != nil)
        #expect(SSHConfigWriter.liveFieldError(.alias, draft: dup, knownAliases: ["other"]) == nil)
        let good = SSHHostDraft(
            alias: "prod", hostName: "server.example.com", user: "deploy",
            port: "22", identityFile: "~/.ssh/id ed25519")
        for field in SSHHostDraftField.allCases {
            #expect(SSHConfigWriter.liveFieldError(field, draft: good) == nil)
        }
    }

    @Test func writerRefusalsMapToOwningFields() {
        #expect(SSHConfigWriter.owningField(of: .invalidAlias("x")) == .alias)
        #expect(SSHConfigWriter.owningField(of: .duplicateAlias("x", existingSource: "y")) == .alias)
        #expect(SSHConfigWriter.owningField(of: .emptyHostName) == .hostName)
        #expect(SSHConfigWriter.owningField(of: .unsafeValue(field: "Host name")) == .hostName)
        #expect(SSHConfigWriter.owningField(of: .unsafeValue(field: "User")) == .user)
        #expect(SSHConfigWriter.owningField(of: .unsafeValue(field: "Identity file")) == .identityFile)
        #expect(SSHConfigWriter.owningField(of: .invalidPort("0")) == .port)
        // Only I/O belongs at form level.
        #expect(SSHConfigWriter.owningField(of: .writeFailed("disk")) == nil)
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
