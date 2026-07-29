import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct SSHHostScanStateTests {
    private func tempDir() throws -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-scanstate-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    // MARK: The scan owner distinguishes the four truths (no try? collapse)

    @Test func missingConfigIsTyped() throws {
        let dir = try tempDir()
        #expect(SSHHostScanState.scan(path: "\(dir)/config") == .configMissing)
    }

    @Test func configWithOnlyPatternsIsNoConcreteAliases() throws {
        let config = try tempDir() + "/config"
        try "Host *\n  User root\nHost prod-*\n  Port 22\n".write(
            toFile: config, atomically: true, encoding: .utf8)
        #expect(SSHHostScanState.scan(path: config) == .noConcreteAliases)
    }

    @Test func concreteAliasesAreReturned() throws {
        let config = try tempDir() + "/config"
        try "Host prod\n  HostName p.internal\n".write(
            toFile: config, atomically: true, encoding: .utf8)
        let state = SSHHostScanState.scan(path: config)
        #expect(state.hosts.map(\.alias) == ["prod"])
    }

    @Test func unreadableConfigIsScanFailed() throws {
        let dir = try tempDir()
        let config = "\(dir)/config"
        // A directory at the config path makes the scanner's read throw.
        try FileManager.default.createDirectory(
            atPath: config, withIntermediateDirectories: true)
        guard case .scanFailed(let reason) = SSHHostScanState.scan(path: config) else {
            Issue.record("expected .scanFailed")
            return
        }
        #expect(!reason.isEmpty)
    }

    // MARK: Picker copy per state — the help text must tell the REAL state

    private func host(_ alias: String) -> SSHHost {
        SSHHost(alias: alias, sourcePath: "/tmp/config")
    }

    @Test func configMissingCopyNamesTheCreateCTA() {
        let p = SSHHostPickerPresentation.present(scan: .configMissing, addedAliases: [])
        #expect(p.addable.isEmpty)
        #expect(p.placeholder == "No config file yet")
        #expect(p.help.contains("does not exist"))
        #expect(p.help.contains("New SSH Host…"))
        #expect(p.inlineFailure == nil)
        // The old lie: claiming every alias was already added.
        #expect(!p.help.contains("already added"))
    }

    @Test func noConcreteAliasesCopyExplainsPatterns() {
        let p = SSHHostPickerPresentation.present(scan: .noConcreteAliases, addedAliases: [])
        #expect(p.placeholder == "No concrete Host aliases found")
        #expect(p.help.contains("pattern"))
        #expect(!p.help.contains("already added"))
    }

    @Test func allAddedCopyOnlyWhenGenuinelyAllAdded() {
        let p = SSHHostPickerPresentation.present(
            scan: .hosts([host("a"), host("b")]), addedAliases: ["a", "b"])
        #expect(p.addable.isEmpty)
        #expect(p.placeholder == "Every alias already added")
        #expect(p.help.contains("already added"))
    }

    @Test func scanFailureIsInlineVisibleNotJustHover() {
        let p = SSHHostPickerPresentation.present(
            scan: .scanFailed("bad include"), addedAliases: [])
        #expect(p.placeholder == "Could not read ~/.ssh/config")
        let failure = try? #require(p.inlineFailure)
        #expect(failure?.contains("bad include") == true)
    }

    @Test func addableHostsExcludeAlreadyAdded() {
        let p = SSHHostPickerPresentation.present(
            scan: .hosts([host("a"), host("b")]), addedAliases: ["a"])
        #expect(p.addable.map(\.alias) == ["b"])
        #expect(p.placeholder == "Choose an alias")
        #expect(p.inlineFailure == nil)
    }

    // MARK: Receipt honesty

    @Test func receiptNeverClaimsABackupForAFreshConfig() {
        let receipt = SSHHostCreationReceipt(
            alias: "prod", configPath: "/u/.ssh/config", backupPath: nil,
            createdConfig: true, appendedBlock: "Host prod\n", connectionFailure: nil)
        #expect(receipt.headline == "Added “prod” to Connections")
        #expect(receipt.detailLines.contains(
            "Created a new config; there was no previous file to back up."))
        #expect(!receipt.detailLines.contains { $0.hasPrefix("Backup:") })
    }

    @Test func receiptNamesTheRealBackupWhenOneWasMade() {
        let receipt = SSHHostCreationReceipt(
            alias: "prod", configPath: "/u/.ssh/config",
            backupPath: "/u/.ssh/config.claudexor-backup-1",
            createdConfig: false, appendedBlock: "Host prod\n", connectionFailure: nil)
        #expect(receipt.detailLines.contains("Backup: /u/.ssh/config.claudexor-backup-1"))
        #expect(!receipt.detailLines.contains { $0.contains("no previous file") })
    }

    @Test func partialOutcomeIsExplicit() {
        let receipt = SSHHostCreationReceipt(
            alias: "prod", configPath: "/u/.ssh/config", backupPath: nil,
            createdConfig: true, appendedBlock: "Host prod\n",
            connectionFailure: "OpenSSH could not resolve “prod”.")
        #expect(receipt.headline.contains("was not added"))
        #expect(receipt.detailLines.contains {
            $0.contains("OpenSSH could not resolve")
        })
    }
}
