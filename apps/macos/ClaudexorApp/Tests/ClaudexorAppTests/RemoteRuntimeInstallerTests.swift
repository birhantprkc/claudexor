import ClaudexorKit
import CryptoKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteRuntimeInstallerTests {
    private let oldBuild = String(repeating: "a", count: 40)
    private let newBuild = String(repeating: "b", count: 40)

    private func temporaryHome() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-remote-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func bundledDevelopmentRuntime() throws -> URL {
        let root = try temporaryHome()
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(
                "ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/remote-runtime-update")
        try FileManager.default.copyItem(
            at: fixture.appendingPathComponent("authority.json"),
            to: root.appendingPathComponent("authority.json"))
        let manifestURL = root.appendingPathComponent("remote-runtime-manifest.json")
        try FileManager.default.copyItem(
            at: fixture.appendingPathComponent("valid-manifest.json"),
            to: manifestURL)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self, from: Data(contentsOf: manifestURL))
        let assets = root.appendingPathComponent("assets")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: false)
        for asset in manifest.assets {
            try Data("fixture-\(asset.target.rawValue)".utf8)
                .write(to: assets.appendingPathComponent(asset.archiveName))
        }
        return root
    }

    @Test func bundledDevelopmentManifestIsVerifiedWithoutReleaseNetwork() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        let manifest = try await installer.loadManifest()
        #expect(manifest.version == "3.4.0")
        #expect(manifest.assets.map(\.target) == RemoteRuntimeTarget.allCases)
        await ssh.shutdown()
    }

    @Test func bundledDevelopmentManifestFailsClosedOnTampering() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifestURL = directory.appendingPathComponent("remote-runtime-manifest.json")
        var manifest = String(decoding: try Data(contentsOf: manifestURL), as: UTF8.self)
        manifest = manifest.replacingOccurrences(
            of: "remote-runtime cross-language test vector — never shipped",
            with: "tampered development runtime")
        try Data(manifest.utf8).write(to: manifestURL)

        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        do {
            _ = try await installer.loadManifest()
            Issue.record("a tampered bundled development manifest must be refused")
        } catch let error as SSHConnectionError {
            #expect(error.localizedDescription.contains("signature or shape is invalid"))
        }
        await ssh.shutdown()
    }

    @Test func bundledDevelopmentManifestRequiresEverySignedAsset() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(contentsOf:
                directory.appendingPathComponent("remote-runtime-manifest.json")))
        let missing = try #require(manifest.assets.first)
        try FileManager.default.removeItem(
            at: directory.appendingPathComponent("assets")
                .appendingPathComponent(missing.archiveName))

        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        await #expect(throws: Error.self) {
            _ = try await installer.loadManifest()
        }
        await ssh.shutdown()
    }

    private func runtimeArchive(
        home: URL,
        marker: String,
        buildSha: String
    ) throws -> (url: URL, digest: String) {
        let payload = home.appendingPathComponent("payload-\(UUID().uuidString)")
        let bin = payload.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let cli = bin.appendingPathComponent("claudexor")
        let script = """
            #!/bin/sh
            set -eu
            case "${1:-} ${2:-}" in
              "remote probe")
                printf '%s\\n' '{"ok":true,"target":"darwin-arm64","version":"3.4.0","buildSha":"\(buildSha)","protocolMajor":3}'
                ;;
              "remote stop")
                test "$3" = "3.4.0"
                test "$4" = "\(buildSha)"
                printf '%s\\n' "\(marker)" >> "$HOME/stops"
                printf '%s\\n' '{"ok":true,"stopped":true}'
                ;;
              "remote bootstrap")
                printf '%s\\n' '{"ok":true,"target":"darwin-arm64","version":"3.4.0","buildSha":"\(buildSha)","protocolMajor":3,"engineVersion":"3.4.0","engineBuildSha":"\(buildSha)","endpoint":{"host":"127.0.0.1","port":43123,"token":"memory-only"}}'
                ;;
              "remote activate")
                root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
                if test "$3" = "-"; then test ! -e "$root/current"; else
                  test "$(readlink "$root/current")" = "$3"
                  rm -f "$root/last-known-good"
                  ln -s "$3" "$root/last-known-good"
                fi
                rm -f "$root/current"
                ln -s "$4" "$root/current"
                printf '%s\\n' '{"ok":true}'
                ;;
              "remote rollback")
                root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
                test "$(readlink "$root/current")" = "$3"
                rm -f "$root/current"
                if test "$4" != "-"; then ln -s "$4" "$root/current"; fi
                printf '%s\\n' '{"ok":true}'
                ;;
              *) exit 64;;
            esac
            """
        try Data(script.utf8).write(to: cli)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: cli.path)
        try Data(marker.utf8).write(to: payload.appendingPathComponent("marker"))
        let archive = home.appendingPathComponent("\(UUID().uuidString).tar.gz")
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-czf", archive.path, "-C", payload.path, "."]
        try tar.run()
        tar.waitUntilExit()
        #expect(tar.terminationStatus == 0)
        let bytes = try Data(contentsOf: archive)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return (archive, digest)
    }

    private func run(
        script: String,
        arguments: [String],
        home: URL
    ) throws -> (status: Int32, stdout: Data, stderr: Data) {
        let scriptURL = home.appendingPathComponent("script-\(UUID().uuidString).sh")
        try Data(script.utf8).write(to: scriptURL)
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [scriptURL.path] + arguments
        process.environment = ProcessInfo.processInfo.environment.merging(["HOME": home.path]) {
            _, replacement in replacement
        }
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        return (
            process.terminationStatus,
            output.fileHandleForReading.readDataToEndOfFile(),
            errors.fileHandleForReading.readDataToEndOfFile())
    }

    private func stageArchive(
        _ archive: URL,
        digest: String,
        home: URL
    ) throws {
        let incoming = home.appendingPathComponent(".claudexor/remote/incoming")
        try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
        try FileManager.default.copyItem(
            at: archive,
            to: incoming.appendingPathComponent("\(digest).tar.gz"))
    }

    @Test func sameVersionRepairKeepsOldClosureUntilCASActivationAndRollsBackPrecisely() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let first = try runtimeArchive(home: home, marker: "old", buildSha: oldBuild)
        try stageArchive(first.url, digest: first.digest, home: home)
        let initial = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", first.digest, "-", "-", "-"],
            home: home)
        #expect(initial.status == 0)
        let root = home.appendingPathComponent(".claudexor/remote")
        let oldTarget = "versions/3.4.0-\(first.digest)"
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == oldTarget)

        let second = try runtimeArchive(home: home, marker: "new", buildSha: newBuild)
        try stageArchive(second.url, digest: second.digest, home: home)
        let repair = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", second.digest, oldTarget, "3.4.0", oldBuild],
            home: home)
        #expect(repair.status == 0)
        let candidateTarget = "versions/3.4.0-\(second.digest)"
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == candidateTarget)
        #expect(
            String(decoding: try Data(
                contentsOf: root.appendingPathComponent(oldTarget).appendingPathComponent("marker")),
                as: UTF8.self) == "old")
        #expect(String(decoding: try Data(contentsOf: home.appendingPathComponent("stops")),
                       as: UTF8.self) == "old\n")

        let rollback = try run(
            script: RemoteRuntimeInstaller.rollbackScript,
            arguments: [
                candidateTarget, oldTarget, "3.4.0", newBuild, "3.4.0", oldBuild,
            ],
            home: home)
        #expect(rollback.status == 0)
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == oldTarget)
        let bootstrap = try JSONSerialization.jsonObject(with: rollback.stdout) as? [String: Any]
        #expect(bootstrap?["engineBuildSha"] as? String == oldBuild)
        #expect(String(decoding: try Data(contentsOf: home.appendingPathComponent("stops")),
                       as: UTF8.self) == "old\nnew\n")
    }

    @Test func installLockAndCurrentCASRefuseConcurrentMutation() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let archive = try runtimeArchive(home: home, marker: "candidate", buildSha: newBuild)
        try stageArchive(archive.url, digest: archive.digest, home: home)
        let lock = home.appendingPathComponent(".claudexor/remote/.install-lock")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
        let locked = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", archive.digest, "-", "-", "-"],
            home: home)
        #expect(locked.status == 75)
        try FileManager.default.removeItem(at: lock)

        let raced = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: [
                "3.4.0", archive.digest, "versions/not-current", "3.3.0",
                String(repeating: "c", count: 40),
            ],
            home: home)
        #expect(raced.status == 75)
        #expect(!FileManager.default.fileExists(
            atPath: home.appendingPathComponent(".claudexor/remote/current").path))
    }
}
