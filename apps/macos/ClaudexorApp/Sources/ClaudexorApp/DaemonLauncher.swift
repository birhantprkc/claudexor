import Foundation
import ClaudexorKit

public enum LocalRuntimeClosureAuthority: Sendable, Equatable {
    /// `nil` means a legacy/corrupt pointer did not carry an authoritative SHA;
    /// reconciliation must keep the compatible daemon rather than guessing.
    case installed(RuntimeClosureIdentity?)
    /// The app-signed bundled script's own exact probe is its authority.
    case bundledStampedProbe
}

public struct LocalRuntimeClosureSelection: Sendable, Equatable {
    public let scriptURL: URL
    public let authority: LocalRuntimeClosureAuthority

    public init(scriptURL: URL, authority: LocalRuntimeClosureAuthority) {
        self.scriptURL = scriptURL
        self.authority = authority
    }
}

/// Starts the engine-service (claudexord) bundled inside the notarized .app, so the app is
/// one-click self-contained. The bundle ships a notarized `node` and a single-file
/// `claudexord.bundle.cjs` in Resources; this spawns them when nothing is already serving the
/// control-api. It is a safe no-op in the SwiftPM dev executable (no bundled assets), where
/// the developer runs `claudexord` from the repo instead.
///
/// M7: the daemon SCRIPT is resolved through `~/.claudexor/runtime/current.json` when an
/// updated runtime closure is installed — `versions/<v>/claudexord.bundle.cjs` — falling back
/// to the app-bundled script on first run or a missing/corrupt pointer. `node` is ALWAYS the
/// app-bundled binary (a Node bump ships a new DMG, never a runtime update).
enum DaemonLauncher {
    static var bundledNode: URL? { Bundle.main.resourceURL?.appendingPathComponent("node") }
    static var bundledDaemon: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexord.bundle.cjs") }
    static var bundledCLI: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexor.bundle.cjs") }
    static var bundledVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// The daemon script to launch: a contained installed runtime only when it
    /// is strictly newer than the app-bundled runtime. A newer DMG therefore
    /// cannot stay pinned to an older (or same-version, different-build)
    /// `current.json` closure. Missing/unorderable versions fail closed to the
    /// bundle, which is the artifact the user explicitly installed.
    /// Nil only when there is no bundled script (dev/SwiftPM).
    static func resolvedDaemon(
        installer: RuntimeInstaller = RuntimeInstaller(),
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon,
        bundledVersion: String? = DaemonLauncher.bundledVersion
    ) -> URL? {
        resolvedRuntime(
            installer: installer,
            bundledDaemon: bundledDaemon,
            bundledVersion: bundledVersion)?.scriptURL
    }

    /// Resolve the launch target together with the exact identity authority that
    /// steady reconciliation must bind to. Installed closures are governed by
    /// current.json; the code-signed bundled closure is governed by its probe.
    static func resolvedRuntime(
        installer: RuntimeInstaller = RuntimeInstaller(),
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon,
        bundledVersion: String? = DaemonLauncher.bundledVersion
    ) -> LocalRuntimeClosureSelection? {
        guard let bundledDaemon else { return nil }
        // QA-073: the pointer's script is resolved through the containment guard
        // — a pointer whose path escapes runtime/versions/<v>, points at a
        // symlink, or names a non-regular file falls back to the bundled runtime
        // instead of launching an attacker-planted script.
        if let current = installer.readCurrent(),
            let script = installer.containedDaemonScript(current),
            let currentVersion = SemanticVersion(current.version),
            let bundledVersion,
            let appVersion = SemanticVersion(bundledVersion),
            currentVersion > appVersion
        {
            let expected = RuntimeClosureIdentity.validated(
                version: current.version, buildSha: current.engineSha)
            return LocalRuntimeClosureSelection(
                scriptURL: script, authority: .installed(expected))
        }
        return LocalRuntimeClosureSelection(
            scriptURL: bundledDaemon, authority: .bundledStampedProbe)
    }

    static var isAvailable: Bool {
        guard let node = bundledNode, let daemon = resolvedDaemon() else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: daemon.path)
    }

    /// Spawn the resolved daemon (detached so it outlives the app). Returns false if the
    /// bundled assets aren't present (dev) or the spawn failed. Node is always app-bundled;
    /// only the daemon-script path is resolved through the installed runtime.
    @discardableResult
    static func startIfNeeded(scriptURL: URL? = nil) -> Bool {
        guard let node = bundledNode, let daemon = scriptURL ?? resolvedDaemon() else { return false }
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: daemon.path) else {
            return false
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [daemon.path]
        process.environment = daemonEnvironment()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return true
        } catch {
            return false
        }
    }

    private static func daemonEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if env["HOME", default: ""].isEmpty || env["HOME"] == "/" {
            env["HOME"] = home
        }
        let existingPath = env["PATH", default: "/usr/bin:/bin:/usr/sbin:/sbin"]
        let extraPaths = [
            "\(home)/.claudexor/node/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.bun/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        var seen = Set<String>()
        env["PATH"] = (extraPaths + [existingPath])
            .flatMap { $0.split(separator: ":").map(String.init) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        return env
    }
}
