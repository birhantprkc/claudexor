import CryptoKit
import Foundation

public enum RemoteRuntimeTarget: String, Codable, CaseIterable, Sendable {
    case linuxX64 = "linux-x64"
    case linuxArm64 = "linux-arm64"
    case darwinX64 = "darwin-x64"
    case darwinArm64 = "darwin-arm64"

    public init?(platform: String, arch: String) {
        self.init(rawValue: "\(platform)-\(arch)")
    }
}

public struct RemoteRuntimeAsset: Codable, Sendable, Equatable {
    public let target: RemoteRuntimeTarget
    public let platform: String
    public let arch: String
    public let nodeVersion: String
    public let archiveName: String
    public let archiveUrl: String
    public let sha256: String
}

public struct RemoteRuntimeManifestV1: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let kind: String
    public let version: String
    public let buildSha: String
    public let protocolMajor: Int
    public let minAppVersion: String
    public let notes: String
    public let assets: [RemoteRuntimeAsset]
    public let keyId: String
    public let algorithm: String
    public let signature: String

    public func asset(for target: RemoteRuntimeTarget) -> RemoteRuntimeAsset? {
        assets.first { $0.target == target }
    }

    public static func archiveName(version: String, target: RemoteRuntimeTarget) -> String {
        "claudexor-remote-runtime-\(version)-\(target.rawValue).tar.gz"
    }

    public static func archiveURL(version: String, target: RemoteRuntimeTarget) -> String {
        "https://github.com/razzant/claudexor/releases/download/v\(version)/\(archiveName(version: version, target: target))"
    }

    func signingBytes() -> Data {
        let encodedAssets = assets.map { asset -> String in
            let fields = [
                ("arch", jsonString(asset.arch)),
                ("archiveName", jsonString(asset.archiveName)),
                ("archiveUrl", jsonString(asset.archiveUrl)),
                ("nodeVersion", jsonString(asset.nodeVersion)),
                ("platform", jsonString(asset.platform)),
                ("sha256", jsonString(asset.sha256)),
                ("target", jsonString(asset.target.rawValue)),
            ]
            return "{\(fields.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ","))}"
        }.joined(separator: ",")
        let fields: [(String, String)] = [
            ("algorithm", jsonString(algorithm)),
            ("assets", "[\(encodedAssets)]"),
            ("buildSha", jsonString(buildSha)),
            ("keyId", jsonString(keyId)),
            ("kind", jsonString(kind)),
            ("minAppVersion", jsonString(minAppVersion)),
            ("notes", jsonString(notes)),
            ("protocolMajor", String(protocolMajor)),
            ("schemaVersion", String(schemaVersion)),
            ("version", jsonString(version)),
        ]
        return Data("{\(fields.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ","))}".utf8)
    }

    public static func verified(
        _ data: Data,
        authority: RuntimeUpdateAuthority = .pinned
    ) -> RemoteRuntimeManifestV1? {
        guard let manifest = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
        guard manifest.schemaVersion == 1,
              manifest.kind == "claudexor-remote-runtime",
              SemanticVersion(manifest.version) != nil,
              SemanticVersion(manifest.minAppVersion) != nil,
              manifest.protocolMajor == 3,
              manifest.buildSha.count == 40,
              isLowercaseHex(manifest.buildSha),
              manifest.keyId == authority.keyId,
              manifest.algorithm == "Ed25519",
              authority.algorithm == "Ed25519",
              manifest.assets.map(\.target) == RemoteRuntimeTarget.allCases,
              let key = authority.signingPublicKey(),
              let signature = Data(base64Encoded: manifest.signature),
              signature.count == 64
        else { return nil }
        for asset in manifest.assets {
            let pieces = asset.target.rawValue.split(separator: "-")
            guard pieces.count == 2,
                  asset.platform == String(pieces[0]),
                  asset.arch == String(pieces[1]),
                  SemanticVersion(asset.nodeVersion) != nil,
                  isLowercaseHexSHA256(asset.sha256),
                  asset.archiveName == archiveName(version: manifest.version, target: asset.target),
                  asset.archiveUrl == archiveURL(version: manifest.version, target: asset.target)
            else { return nil }
        }
        guard key.isValidSignature(signature, for: manifest.signingBytes()) else { return nil }
        return manifest
    }
}

public struct RemoteRuntimeProbe: Codable, Sendable, Equatable {
    public let target: RemoteRuntimeTarget
    public let version: String
    public let buildSha: String
    public let protocolMajor: Int

    public init(
        target: RemoteRuntimeTarget,
        version: String,
        buildSha: String,
        protocolMajor: Int
    ) {
        self.target = target
        self.version = version
        self.buildSha = buildSha
        self.protocolMajor = protocolMajor
    }
}

public enum RemoteRuntimeCompatibilityDecision: Sendable, Equatable {
    case installRequired
    case blockingUpdate(RemoteRuntimeAsset)
    case updateAvailable(RemoteRuntimeAsset)
    case useCurrentAndOfferUpdate(RemoteRuntimeAsset)
    case useCurrent
    case appUpdateRequired
}

public enum RemoteRuntimeInstallPolicyDecision: Sendable, Equatable {
    case allow
    case appUpdateRequired
    case refuseDowngrade
}

/// A second, mandatory fence for explicit/repair installs. Callers must not be
/// able to bypass the compatibility decision by invoking the installer
/// directly from a Settings button.
public func decideRemoteRuntimeInstall(
    current: RemoteRuntimeProbe?,
    target: RemoteRuntimeTarget,
    manifest: RemoteRuntimeManifestV1,
    appVersion: String
) -> RemoteRuntimeInstallPolicyDecision {
    guard appSatisfies(appVersion: appVersion, minAppVersion: manifest.minAppVersion) else {
        return .appUpdateRequired
    }
    guard let current, current.target == target else { return .allow }
    if current.protocolMajor > manifest.protocolMajor { return .refuseDowngrade }
    if let currentVersion = SemanticVersion(current.version),
       let availableVersion = SemanticVersion(manifest.version),
       currentVersion > availableVersion
    {
        return .refuseDowngrade
    }
    return .allow
}

public func decideRemoteRuntime(
    probe: RemoteRuntimeProbe?,
    manifest: RemoteRuntimeManifestV1,
    appVersion: String,
    hasActiveTasks: Bool
) -> RemoteRuntimeCompatibilityDecision {
    guard appSatisfies(appVersion: appVersion, minAppVersion: manifest.minAppVersion) else {
        return .appUpdateRequired
    }
    guard let asset = manifest.asset(for: probe?.target ?? .darwinArm64) else {
        return .appUpdateRequired
    }
    guard let probe else { return .installRequired }
    if probe.protocolMajor > manifest.protocolMajor {
        // A newer protocol is not a reason to downgrade a remote runtime.
        return .appUpdateRequired
    }
    if probe.protocolMajor < manifest.protocolMajor { return .blockingUpdate(asset) }
    guard let current = SemanticVersion(probe.version),
          let available = SemanticVersion(manifest.version)
    else { return .blockingUpdate(asset) }
    if current >= available { return .useCurrent }
    return hasActiveTasks ? .useCurrentAndOfferUpdate(asset) : .updateAvailable(asset)
}
