import SwiftUI
import ClaudexorKit

/// Settings › Harnesses: install a vendor CLI on a connected SSH host
/// (issue #89). The confirmation dialog shows the remote runtime's own
/// `harness install --dry-run --json` disclosure — exact command, install
/// destination, and version pin — and the installer itself runs in the
/// visible embedded terminal, where the user watches it like interactive
/// SSH auth. npm harnesses install the exact pinned version this release
/// was verified against; Cursor's script is downloaded in full and executed
/// under the user's eyes because it cannot be pinned.
struct RemoteHarnessInstallSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if !model.remoteConnections.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Remote Harness Install", systemImage: "arrow.down.circle")
                Text(
                    "Puts a vendor CLI on an SSH host. Claude, Codex, and OpenCode install the exact npm version this Claudexor release was verified against; Cursor's installer script is downloaded in full and runs in the embedded terminal where you watch it. Nothing runs before you confirm the exact command.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(model.remoteConnections) { connection in
                    HStack {
                        Text(connection.displayName)
                        Spacer()
                        Menu("Install…") {
                            ForEach(["claude", "codex", "cursor", "opencode"], id: \.self) {
                                harness in
                                Button(harness.capitalized) {
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
                "Install \(model.remoteHarnessInstallPrompt?.harness.capitalized ?? "harness")?",
                isPresented: Binding(
                    get: { model.remoteHarnessInstallPrompt != nil },
                    set: { if !$0 { model.remoteHarnessInstallPrompt = nil } })
            ) {
                Button("Run installer") {
                    guard let prompt = model.remoteHarnessInstallPrompt else { return }
                    Task { await model.confirmRemoteHarnessInstall(prompt) }
                }
                Button("Cancel", role: .cancel) { model.remoteHarnessInstallPrompt = nil }
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
        let pin = prompt.pinnedVersion.map {
            "Pinned version: \($0) (exact; npm verifies its registry checksum)"
        } ?? "No version pin: Cursor ships no npm artifact — the downloaded script runs in the embedded terminal where you watch it"
        return """
        Command: \(prompt.command)
        Install location: \(prompt.installLocation)
        \(pin)

        Runs on \(host) in the embedded terminal. Claudexor runs Harness Doctor afterward.
        """
    }
}
