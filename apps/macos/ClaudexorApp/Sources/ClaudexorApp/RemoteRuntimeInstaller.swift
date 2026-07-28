import ClaudexorKit
import CryptoKit
import Foundation

private let remoteManifestURL = URL(
    string: "https://github.com/razzant/claudexor/releases/latest/download/remote-runtime-manifest.json")!

struct RemoteBootstrapResponse: Decodable, Sendable {
    struct Endpoint: Decodable, Sendable {
        let host: String
        let port: Int
        let token: String
    }

    let ok: Bool
    let target: RemoteRuntimeTarget
    let version: String
    let buildSha: String
    let protocolMajor: Int
    let engineVersion: String?
    let engineBuildSha: String?
    let endpoint: Endpoint
}

actor RemoteRuntimeInstaller {
    private struct BundledDevelopmentAuthority: Decodable {
        let keyId: String
        let algorithm: String
        let publicKeyPem: String
    }

    private struct RuntimeSnapshot: Sendable {
        let pointerTarget: String?
        let probe: RemoteRuntimeProbe?
    }

    private struct Activation: Sendable {
        let candidateTarget: String
        let candidate: RemoteRuntimeProbe
        let previousTarget: String?
        let previous: RemoteRuntimeProbe?
    }

    private let ssh: SSHConnectionManager
    private let session: URLSession
    private let developmentDirectory: URL?
    private var bundledManifest: RemoteRuntimeManifestV1?
    private var bundledAssetsDirectory: URL?
    private var pendingActivations: [UUID: Activation] = [:]

    init(
        ssh: SSHConnectionManager,
        session: URLSession = .shared,
        developmentDirectory: URL? = RemoteRuntimeInstaller.defaultDevelopmentDirectory
    ) {
        self.ssh = ssh
        self.session = session
        self.developmentDirectory = developmentDirectory
    }

    func loadManifest() async throws -> RemoteRuntimeManifestV1 {
        if let developmentDirectory {
            return try loadBundledDevelopmentManifest(from: developmentDirectory)
        }
        bundledManifest = nil
        bundledAssetsDirectory = nil
        let (data, response) = try await session.data(from: remoteManifestURL)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SSHConnectionError.unavailable("remote runtime manifest is unavailable")
        }
        guard let manifest = RemoteRuntimeManifestV1.verified(data) else {
            throw SSHConnectionError.unavailable(
                "remote runtime manifest signature or shape is invalid")
        }
        return manifest
    }

    private static var defaultDevelopmentDirectory: URL? {
        #if CLAUDEXOR_DEV_REMOTE_RUNTIME
        Bundle.main.resourceURL?
            .appendingPathComponent("remote-runtime-dev", isDirectory: true)
        #else
        nil
        #endif
    }

    private func loadBundledDevelopmentManifest(
        from directory: URL
    ) throws -> RemoteRuntimeManifestV1 {
        do {
            let authorityData = try readRegularFile(
                directory.appendingPathComponent("authority.json"))
            let authorityRecord = try JSONDecoder().decode(
                BundledDevelopmentAuthority.self, from: authorityData)
            let authority = RuntimeUpdateAuthority(
                keyId: authorityRecord.keyId,
                algorithm: authorityRecord.algorithm,
                publicKeyPem: authorityRecord.publicKeyPem)
            let manifestData = try readRegularFile(
                directory.appendingPathComponent("remote-runtime-manifest.json"))
            guard let manifest = RemoteRuntimeManifestV1.verified(
                manifestData, authority: authority)
            else {
                throw SSHConnectionError.unavailable(
                    "bundled development remote runtime signature or shape is invalid")
            }
            let assetsDirectory = directory.appendingPathComponent("assets", isDirectory: true)
            for asset in manifest.assets {
                _ = try readRegularFile(
                    assetsDirectory.appendingPathComponent(asset.archiveName),
                    loadBytes: false)
            }
            bundledManifest = manifest
            bundledAssetsDirectory = assetsDirectory
            return manifest
        } catch let error as SSHConnectionError {
            throw error
        } catch {
            throw SSHConnectionError.unavailable(
                "bundled development remote runtime is unavailable: \(error.localizedDescription)")
        }
    }

    func detectTarget(on connection: RemoteConnection) async throws -> RemoteRuntimeTarget {
        let result = try await ssh.execute(
            connection,
            remoteCommand: "printf '%s\\n' \"$(uname -s)\" \"$(uname -m)\"")
        let lines = String(decoding: result.stdout, as: UTF8.self)
            .split(whereSeparator: \.isNewline).map(String.init)
        guard lines.count >= 2 else {
            throw SSHConnectionError.unavailable("remote uname returned no platform identity")
        }
        let platform: String
        switch lines[0].lowercased() {
        case "linux": platform = "linux"
        case "darwin": platform = "darwin"
        default:
            throw SSHConnectionError.unavailable("unsupported remote platform \(lines[0])")
        }
        let architecture: String
        switch lines[1].lowercased() {
        case "x86_64", "amd64": architecture = "x64"
        case "arm64", "aarch64": architecture = "arm64"
        default:
            throw SSHConnectionError.unavailable("unsupported remote architecture \(lines[1])")
        }
        guard let target = RemoteRuntimeTarget(platform: platform, arch: architecture) else {
            throw SSHConnectionError.unavailable("unsupported remote target")
        }
        return target
    }

    func probe(on connection: RemoteConnection) async throws -> RemoteRuntimeProbe {
        let result = try await ssh.execute(
            connection,
            remoteCommand:
                "~/.claudexor/remote/current/bin/claudexor remote probe --json")
        return try JSONDecoder().decode(RemoteRuntimeProbe.self, from: result.stdout)
    }

    func bootstrap(on connection: RemoteConnection) async throws -> RemoteBootstrapResponse {
        let result = try await ssh.execute(
            connection,
            remoteCommand:
                "~/.claudexor/remote/current/bin/claudexor remote bootstrap --json")
        let bootstrap = try JSONDecoder().decode(RemoteBootstrapResponse.self, from: result.stdout)
        guard bootstrap.ok,
              bootstrap.protocolMajor == 3,
              bootstrap.endpoint.host == "127.0.0.1",
              (1 ... 65_535).contains(bootstrap.endpoint.port),
              !bootstrap.endpoint.token.isEmpty
        else { throw SSHConnectionError.unavailable("remote bootstrap response was invalid") }
        return bootstrap
    }

    private func bootstrap(
        on connection: RemoteConnection,
        expecting expected: RemoteRuntimeProbe
    ) async throws -> RemoteBootstrapResponse {
        let value = try await bootstrap(on: connection)
        guard value.target == expected.target,
              value.version == expected.version,
              value.buildSha == expected.buildSha,
              value.protocolMajor == expected.protocolMajor,
              value.engineVersion == expected.version,
              value.engineBuildSha == expected.buildSha
        else {
            throw SSHConnectionError.unavailable(
                "the restarted daemon does not match the activated runtime")
        }
        return value
    }

    private func currentPointerTarget(on connection: RemoteConnection) async throws -> String? {
        let result = try await ssh.execute(
            connection,
            remoteCommand: """
                set -eu
                current="$HOME/.claudexor/remote/current"
                if test -L "$current"; then
                  readlink "$current"
                elif test -e "$current"; then
                  exit 73
                fi
                """)
        let value = String(decoding: result.stdout, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.hasPrefix("versions/"),
              !value.dropFirst("versions/".count).contains("/"),
              !value.contains("..")
        else {
            throw SSHConnectionError.unavailable("remote runtime current pointer is unsafe")
        }
        return value
    }

    /// Snapshot the pointer around the probe so the install policy and the
    /// compare-and-swap token always describe the same immutable closure.
    private func snapshot(on connection: RemoteConnection) async throws -> RuntimeSnapshot {
        for _ in 0 ..< 3 {
            let before = try await currentPointerTarget(on: connection)
            let value: RemoteRuntimeProbe?
            if before == nil {
                value = nil
            } else {
                value = try await probe(on: connection)
            }
            let after = try await currentPointerTarget(on: connection)
            if before == after {
                return RuntimeSnapshot(pointerTarget: before, probe: value)
            }
        }
        throw SSHConnectionError.unavailable(
            "remote runtime changed concurrently; retry the installation")
    }

    func install(
        _ manifest: RemoteRuntimeManifestV1,
        target: RemoteRuntimeTarget,
        on connection: RemoteConnection,
        appVersion: String
    ) async throws {
        let initial = try await snapshot(on: connection)
        switch decideRemoteRuntimeInstall(
            current: initial.probe, target: target, manifest: manifest, appVersion: appVersion)
        {
        case .allow:
            break
        case .appUpdateRequired:
            throw SSHConnectionError.unavailable(
                "this runtime requires a newer Claudexor app")
        case .refuseDowngrade:
            throw SSHConnectionError.unavailable(
                "the host runtime is newer and will not be downgraded")
        }
        guard let asset = manifest.asset(for: target),
              let url = URL(string: asset.archiveUrl),
              asset.archiveName == RemoteRuntimeManifestV1.archiveName(
                version: manifest.version, target: target)
        else { throw SSHConnectionError.unavailable("manifest has no valid asset for \(target.rawValue)") }
        let archive: Data
        if manifest == bundledManifest, let bundledAssetsDirectory {
            archive = try readRegularFile(
                bundledAssetsDirectory.appendingPathComponent(asset.archiveName))
        } else {
            let (temporaryURL, response) = try await session.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw SSHConnectionError.unavailable("remote runtime download failed")
            }
            archive = try Data(contentsOf: temporaryURL, options: .mappedIfSafe)
        }
        let digest = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
        guard digest == asset.sha256 else {
            throw SSHConnectionError.unavailable("remote runtime archive digest mismatch")
        }
        // digest == asset.sha256 was proven above, so the name is 64 hex
        // chars; the posixQuote still keeps every remote interpolation on the
        // single audited quoting path.
        let incoming =
            "umask 077; mkdir -p \"$HOME/.claudexor/remote/incoming\"; " +
            "cat > \"$HOME/.claudexor/remote/incoming/\"" +
            SSHCommandFactory.posixQuote("\(asset.sha256).tar.gz")
        _ = try await ssh.execute(connection, remoteCommand: incoming, stdin: archive)

        let installCommand =
            "sh -s -- \(SSHCommandFactory.posixQuote(manifest.version)) " +
            "\(SSHCommandFactory.posixQuote(asset.sha256)) " +
            "\(SSHCommandFactory.posixQuote(initial.pointerTarget ?? "-")) " +
            "\(SSHCommandFactory.posixQuote(initial.probe?.version ?? "-")) " +
            SSHCommandFactory.posixQuote(initial.probe?.buildSha ?? "-")
        let candidate = RemoteRuntimeProbe(
            target: target,
            version: manifest.version,
            buildSha: manifest.buildSha,
            protocolMajor: manifest.protocolMajor)
        let activation = Activation(
            candidateTarget: "versions/\(manifest.version)-\(asset.sha256)",
            candidate: candidate,
            previousTarget: initial.pointerTarget,
            previous: initial.probe)
        do {
            _ = try await ssh.execute(
                connection,
                remoteCommand: installCommand,
                stdin: Data(Self.installScript.utf8))
        } catch {
            // The SSH result can be lost after the atomic rename. Only claim an
            // activation when the remote CAS target proves that it happened.
            let observed = try? await currentPointerTarget(on: connection)
            do {
                if observed == activation.candidateTarget {
                    pendingActivations[connection.id] = activation
                    try await rollback(on: connection)
                } else if observed == activation.previousTarget,
                          let previous = activation.previous
                {
                    _ = try await bootstrap(on: connection, expecting: previous)
                }
            } catch let recoveryError {
                throw SSHConnectionError.unavailable(
                    "runtime activation failed and recovery failed: \(recoveryError.localizedDescription)")
            }
            throw error
        }
        pendingActivations[connection.id] = activation
        do {
            _ = try await bootstrap(on: connection, expecting: candidate)
        } catch {
            do {
                try await rollback(on: connection)
            } catch let rollbackError {
                throw SSHConnectionError.unavailable(
                    "candidate runtime failed to restart and recovery failed: \(rollbackError.localizedDescription)")
            }
            throw error
        }
    }

    func rollback(on connection: RemoteConnection) async throws {
        guard let activation = pendingActivations[connection.id] else {
            throw SSHConnectionError.unavailable("there is no pending runtime activation")
        }
        let command =
            "sh -s -- \(SSHCommandFactory.posixQuote(activation.candidateTarget)) " +
            "\(SSHCommandFactory.posixQuote(activation.previousTarget ?? "-")) " +
            "\(SSHCommandFactory.posixQuote(activation.candidate.version)) " +
            "\(SSHCommandFactory.posixQuote(activation.candidate.buildSha)) " +
            "\(SSHCommandFactory.posixQuote(activation.previous?.version ?? "-")) " +
            SSHCommandFactory.posixQuote(activation.previous?.buildSha ?? "-")
        let result = try await ssh.execute(
            connection,
            remoteCommand: command,
            stdin: Data(Self.rollbackScript.utf8))
        if let previous = activation.previous {
            let bootstrap = try JSONDecoder().decode(
                RemoteBootstrapResponse.self, from: result.stdout)
            guard bootstrap.target == previous.target,
                  bootstrap.version == previous.version,
                  bootstrap.buildSha == previous.buildSha,
                  bootstrap.protocolMajor == previous.protocolMajor,
                  bootstrap.engineVersion == previous.version,
                  bootstrap.engineBuildSha == previous.buildSha
            else {
                throw SSHConnectionError.unavailable(
                    "rollback restarted a daemon with the wrong identity")
            }
        }
        pendingActivations.removeValue(forKey: connection.id)
    }

    func rollbackOrDeactivate(on connection: RemoteConnection) async {
        try? await rollback(on: connection)
    }

    /// The app calls this only after its tunneled Control API handshake has
    /// accepted the new daemon. Until then rollback remains a precise CAS.
    func commitActivation(on connection: RemoteConnection) {
        pendingActivations.removeValue(forKey: connection.id)
    }

    private func readRegularFile(
        _ url: URL,
        loadBytes: Bool = true
    ) throws -> Data {
        let values = try url.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw SSHConnectionError.unavailable(
                "bundled development runtime contains a non-regular file")
        }
        return loadBytes ? try Data(contentsOf: url, options: .mappedIfSafe) : Data()
    }

    static let installScript = """
        set -eu
        version=$1
        expected=$2
        expected_current=$3
        previous_version=$4
        previous_sha=$5
        case "$version" in *[!0-9.]*|'') exit 64;; esac
        case "$expected" in *[!0-9a-f]*|'') exit 64;; esac
        test "${#expected}" -eq 64
        case "$expected_current" in
          -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
          versions/*)
            case "$expected_current" in */*/*|*..*) exit 64;; esac
            case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
            case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
            test "${#previous_sha}" -eq 40;;
          *) exit 64;;
        esac
        root="$HOME/.claudexor/remote"
        archive="$root/incoming/$expected.tar.gz"
        staging="$root/.staging/$version-$$"
        candidate="versions/$version-$expected"
        destination="$root/$candidate"
        lock="$root/.install-lock"
        umask 077
        mkdir -p "$root/incoming" "$root/.staging" "$root/versions"
        if ! mkdir "$lock" 2>/dev/null; then
          echo "another install holds the lock $lock (remove it if no install is running)" >&2
          exit 75
        fi
        cleanup() {
          rm -rf "$staging"
          rmdir "$lock" 2>/dev/null || true
        }
        trap cleanup EXIT HUP INT TERM
        actual_current=-
        if test -L "$root/current"; then
          actual_current=$(readlink "$root/current")
        elif test -e "$root/current"; then
          exit 73
        fi
        test "$actual_current" = "$expected_current" || exit 75
        if command -v shasum >/dev/null 2>&1; then
          actual=$(shasum -a 256 "$archive" | awk '{print $1}')
        elif command -v sha256sum >/dev/null 2>&1; then
          actual=$(sha256sum "$archive" | awk '{print $1}')
        else
          exit 69
        fi
        test "$actual" = "$expected"
        # Capture both listings through plain assignments: `set -e` propagates
        # a tar failure out of `x=$(...)`, while a substitution inline in the
        # heredoc body would silently truncate the listing on a corrupt
        # archive. Heredoc expansion never field-splits or globs, and the
        # anchored patterns are closed under raw-newline entry names: any
        # `..` path component leaves `..`, `../*`, `*/../*` or `*/..` on at
        # least one physical line no matter where the name is split.
        listing=$(tar -tzf "$archive")
        while IFS= read -r entry; do
          case "$entry" in /*|..|../*|*/../*|*/..) exit 65;; esac
        done <<EOF
        $listing
        EOF
        verbose=$(tar -tvzf "$archive")
        while IFS= read -r detail; do
          case "$detail" in
            -*) ;;
            d*) ;;
            *) exit 65;;
          esac
        done <<EOF
        $verbose
        EOF
        mkdir "$staging"
        tar -xzf "$archive" -C "$staging" --no-same-owner
        test -x "$staging/bin/claudexor"
        "$staging/bin/claudexor" remote probe --json >/dev/null
        printf '%s\\n' "$expected" > "$staging/.archive-sha256"
        if test -e "$destination"; then
          test -d "$destination" && test ! -L "$destination"
          test -f "$destination/.archive-sha256"
          test "$(cat "$destination/.archive-sha256")" = "$expected"
          test -x "$destination/bin/claudexor"
          "$destination/bin/claudexor" remote probe --json >/dev/null
        else
          mv "$staging" "$destination"
        fi
        if test "$expected_current" != "-"; then
          "$root/$expected_current/bin/claudexor" \
            remote stop "$previous_version" "$previous_sha" --json >/dev/null
          test -L "$root/current"
          test "$(readlink "$root/current")" = "$expected_current"
        else
          test ! -e "$root/current"
        fi
        "$destination/bin/claudexor" \
          remote activate "$expected_current" "$candidate" --json >/dev/null
        rm -f "$archive"
        rm -rf "$staging"
        trap - EXIT HUP INT TERM
        rmdir "$lock"
        """

    static let rollbackScript = """
        set -eu
        candidate=$1
        previous=$2
        candidate_version=$3
        candidate_sha=$4
        previous_version=$5
        previous_sha=$6
        case "$candidate" in versions/*) ;; *) exit 64;; esac
        case "$candidate" in */*/*|*..*) exit 64;; esac
        case "$previous" in
          -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
          versions/*)
            case "$previous" in */*/*|*..*) exit 64;; esac
            case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
            case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
            test "${#previous_sha}" -eq 40;;
          *) exit 64;;
        esac
        case "$candidate_version" in *[!0-9.]*|'') exit 64;; esac
        case "$candidate_sha" in *[!0-9a-f]*|'') exit 64;; esac
        test "${#candidate_sha}" -eq 40
        root="$HOME/.claudexor/remote"
        lock="$root/.install-lock"
        umask 077
        if ! mkdir "$lock" 2>/dev/null; then
          echo "another install holds the lock $lock (remove it if no install is running)" >&2
          exit 75
        fi
        cleanup() { rmdir "$lock" 2>/dev/null || true; }
        trap cleanup EXIT HUP INT TERM
        test -L "$root/current"
        test "$(readlink "$root/current")" = "$candidate"
        "$root/$candidate/bin/claudexor" \
          remote stop "$candidate_version" "$candidate_sha" --json >/dev/null
        test -L "$root/current"
        test "$(readlink "$root/current")" = "$candidate"
        "$root/$candidate/bin/claudexor" \
          remote rollback "$candidate" "$previous" --json >/dev/null
        if test "$previous" = "-"; then
          printf '%s\\n' '{"ok":true,"deactivated":true}'
        else
          test -d "$root/$previous"
          test ! -L "$root/$previous"
          "$root/$previous/bin/claudexor" remote bootstrap --json
        fi
        trap - EXIT HUP INT TERM
        rmdir "$lock"
        """
}
