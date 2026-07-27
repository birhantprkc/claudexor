import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct RemoteRuntimeTests {
    private func fixture(_ name: String) throws -> Data {
        let url = try #require(
            Bundle.module.url(
                forResource: name, withExtension: "json",
                subdirectory: "Fixtures/remote-runtime-update"))
        return try Data(contentsOf: url)
    }

    private func testAuthority() throws -> RuntimeUpdateAuthority {
        struct Authority: Decodable {
            let keyId: String
            let algorithm: String
            let publicKeyPem: String
        }
        let authority = try JSONDecoder().decode(Authority.self, from: fixture("authority"))
        return RuntimeUpdateAuthority(
            keyId: authority.keyId,
            algorithm: authority.algorithm,
            publicKeyPem: authority.publicKeyPem)
    }

    private func asset(_ target: RemoteRuntimeTarget) -> RemoteRuntimeAsset {
        let pieces = target.rawValue.split(separator: "-")
        return RemoteRuntimeAsset(
            target: target,
            platform: String(pieces[0]),
            arch: String(pieces[1]),
            nodeVersion: "24.16.0",
            archiveName: RemoteRuntimeManifestV1.archiveName(version: "3.2.0", target: target),
            archiveUrl: RemoteRuntimeManifestV1.archiveURL(version: "3.2.0", target: target),
            sha256: String(repeating: "a", count: 64))
    }

    private func manifest() -> RemoteRuntimeManifestV1 {
        RemoteRuntimeManifestV1(
            schemaVersion: 1,
            kind: "claudexor-remote-runtime",
            version: "3.2.0",
            buildSha: String(repeating: "1", count: 40),
            protocolMajor: 3,
            minAppVersion: "3.1.0",
            notes: "",
            assets: RemoteRuntimeTarget.allCases.map(asset),
            keyId: "test",
            algorithm: "Ed25519",
            signature: "")
    }

    @Test func selectsAllFourTargets() {
        let value = manifest()
        for target in RemoteRuntimeTarget.allCases {
            #expect(value.asset(for: target)?.target == target)
        }
    }

    @Test func swiftVerifiesTheJavaScriptSignedFourTargetFixture() throws {
        let value = RemoteRuntimeManifestV1.verified(
            try fixture("valid-manifest"), authority: try testAuthority())
        #expect(value?.version == "3.4.0")
        #expect(value?.assets.map(\.target) == RemoteRuntimeTarget.allCases)
    }

    @Test func signatureRejectsTamperedRemoteAssetDigest() throws {
        var object =
            try JSONSerialization.jsonObject(with: fixture("valid-manifest")) as! [String: Any]
        var assets = object["assets"] as! [[String: Any]]
        assets[0]["sha256"] = String(repeating: "f", count: 64)
        object["assets"] = assets
        let data = try JSONSerialization.data(withJSONObject: object)
        #expect(RemoteRuntimeManifestV1.verified(data, authority: try testAuthority()) == nil)
    }

    @Test func compatibilityNeverDowngradesNewerRuntime() {
        let probe = RemoteRuntimeProbe(
            target: .linuxArm64,
            version: "4.0.0",
            buildSha: String(repeating: "2", count: 40),
            protocolMajor: 3)
        #expect(
            decideRemoteRuntime(
                probe: probe, manifest: manifest(), appVersion: "3.2.0", hasActiveTasks: false)
                == .useCurrent)
    }

    @Test func directInstallPolicyHonorsAppFloorAndRefusesDowngrade() {
        let newer = RemoteRuntimeProbe(
            target: .linuxX64,
            version: "4.0.0",
            buildSha: String(repeating: "2", count: 40),
            protocolMajor: 3)
        #expect(
            decideRemoteRuntimeInstall(
                current: newer, target: .linuxX64, manifest: manifest(), appVersion: "3.2.0")
                == .refuseDowngrade)
        #expect(
            decideRemoteRuntimeInstall(
                current: nil, target: .linuxX64, manifest: manifest(), appVersion: "3.0.0")
                == .appUpdateRequired)
        #expect(
            decideRemoteRuntimeInstall(
                current: nil, target: .linuxX64, manifest: manifest(), appVersion: "dev")
                == .allow)
    }

    @Test func incompatibleOldProtocolIsBlockingButCompatibleOldCanFinishWork() {
        let oldProtocol = RemoteRuntimeProbe(
            target: .linuxX64,
            version: "3.1.0",
            buildSha: String(repeating: "2", count: 40),
            protocolMajor: 2)
        if case .blockingUpdate = decideRemoteRuntime(
            probe: oldProtocol, manifest: manifest(), appVersion: "3.2.0", hasActiveTasks: true
        ) {} else {
            Issue.record("expected blocking update")
        }
        let compatible = RemoteRuntimeProbe(
            target: .linuxX64,
            version: "3.1.0",
            buildSha: String(repeating: "2", count: 40),
            protocolMajor: 3)
        if case .useCurrentAndOfferUpdate = decideRemoteRuntime(
            probe: compatible, manifest: manifest(), appVersion: "3.2.0", hasActiveTasks: true
        ) {} else {
            Issue.record("expected deferred compatible update")
        }
    }
}
