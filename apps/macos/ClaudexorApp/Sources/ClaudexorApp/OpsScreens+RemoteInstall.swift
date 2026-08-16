import SwiftUI
import ClaudexorKit

/// Settings › Harnesses: install a vendor CLI on a connected SSH host
/// (issue #89). The confirmation dialog shows the remote runtime's own
/// `harness install --dry-run --json` disclosure — exact command, install
/// destination, and version pin — and the installer itself runs in the
/// visible embedded terminal, where the user watches it like interactive
/// SSH auth. Claude and Codex install the exact pinned npm version this
/// release was verified against; OpenCode installs its exact pin as a
/// deterministic install target (no recorded verification fixture covers
/// it); the script vendors (Antigravity and Cursor) have their installer
/// downloaded in full and executed under the user's eyes because they
/// cannot be pinned. Every vendor NAME here comes from `HarnessFamily.label`
/// — never `id.capitalized`, which renders Antigravity as "Agy".
struct RemoteHarnessInstallSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if !model.remoteConnections.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Remote Harness Install", systemImage: "arrow.down.circle")
                Text(
                    "Puts a vendor CLI on an SSH host. Claude and Codex install the exact npm version this Claudexor release was verified against; OpenCode installs its exact pinned version as a deterministic target (not covered by recorded verification fixtures); the Antigravity and Cursor installer scripts ship no pinnable npm artifact, so each is downloaded in full and runs in the embedded terminal where you watch it. Nothing runs before you confirm the exact command.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(model.remoteConnections) { connection in
                    HStack {
                        Text(connection.displayName)
                        Spacer()
                        Menu("Install…") {
                            ForEach(installableRemoteHarnesses, id: \.self) {
                                harness in
                                Button(HarnessFamily(rawValue: harness).label) {
                                    Task {
                                        await model.startRemoteHarnessInstall(
                                            connectionID: connection.id, harness: harness)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: 140)
                        .help(
                            "Fetches the exact install command from \(connection.displayName) and asks for confirmation before anything runs.")
                    }
                    if let message = model.remoteConnectionMessages[connection.id] {
                        Text(message).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(Theme.separator, lineWidth: 1))
            .confirmationDialog(
                "Install \(model.remoteHarnessInstallPrompt.map { HarnessFamily(rawValue: $0.harness).label } ?? "harness")?",
                isPresented: Binding(
                    get: { model.remoteHarnessInstallPrompt != nil },
                    set: { presented in
                        guard !presented, let prompt = model.remoteHarnessInstallPrompt else {
                            return
                        }
                        model.dismissRemoteHarnessInstallPrompt(prompt)
                    })
            ) {
                Button("Run installer") {
                    guard let prompt = model.remoteHarnessInstallPrompt,
                          model.acceptRemoteHarnessInstallPrompt(prompt)
                    else { return }
                    Task { await model.confirmRemoteHarnessInstall(prompt) }
                }
                Button("Cancel", role: .cancel) {
                    guard let prompt = model.remoteHarnessInstallPrompt else { return }
                    model.dismissRemoteHarnessInstallPrompt(prompt)
                }
            } message: {
                if let prompt = model.remoteHarnessInstallPrompt {
                    Text(Self.disclosureText(prompt, model: model))
                }
            }
        }
    }

    static func disclosureText(
        _ prompt: RemoteHarnessInstallPrompt, model: AppModel
    ) -> String {
        let host = model.remoteConnections
            .first(where: { $0.id == prompt.connectionID })?.displayName ?? "the remote host"
        // The vendor's own product name. The unpinnable branch used to say
        // "Cursor" outright, which named the wrong vendor the moment a second
        // script installer (Antigravity) reached it — in the most
        // security-sensitive dialog in the app.
        let vendor = HarnessFamily(rawValue: prompt.harness).label
        let pin: String
        switch prompt.verification {
        case .releaseVerified:
            pin = "Pinned version: \(prompt.pinnedVersion!) "
                + "(exact; the version this release was verified against; "
                + "npm verifies its registry integrity checksum)"
        case .deterministicOnly:
            pin = "Pinned version: \(prompt.pinnedVersion!) "
                + "(exact deterministic install target; not covered by recorded "
                + "verification fixtures; npm verifies its registry integrity checksum)"
        case .humanObserved:
            pin = "No version pin: \(vendor) ships no pinnable npm artifact; the vendor script "
                + "is downloaded in full, its size and SHA-256 print, and it runs in the "
                + "embedded terminal where you watch it"
        }
        return """
        Command: \(prompt.command)
        Install location: \(prompt.installLocation)
        \(pin)

        Runs on \(host) in the embedded terminal. Claudexor runs Harness Doctor afterward.
        """
    }
}
