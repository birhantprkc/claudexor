import ClaudexorKit
import SwiftUI

struct ConnectionsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedAlias = ""

    private var addableHosts: [SSHHost] {
        model.availableSSHHosts.filter { host in
            !model.remoteConnections.contains { $0.sshAlias == host.alias }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Label("SSH Connections", systemImage: "network")
                    .font(.title2.weight(.semibold))
                Text(
                    "Hosts come from ~/.ssh/config. Claudexor delegates keys, ssh-agent, known_hosts, MFA, ProxyJump, and ProxyCommand to /usr/bin/ssh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Picker("SSH host", selection: $selectedAlias) {
                        Text("Choose an alias").tag("")
                        ForEach(addableHosts) { host in
                            Text(host.alias).tag(host.alias)
                        }
                    }
                    Button {
                        model.addRemoteConnection(alias: selectedAlias)
                        selectedAlias = ""
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .disabled(selectedAlias.isEmpty)
                    Button {
                        model.refreshSSHHosts()
                    } label: {
                        Label("Rescan", systemImage: "arrow.clockwise")
                    }
                }
            }

            if model.remoteConnections.isEmpty {
                ContentUnavailableView(
                    "No remote connections",
                    systemImage: "network.slash",
                    description: Text(
                        "Add a concrete Host alias from ~/.ssh/config. Pattern hosts are intentionally hidden."))
            } else {
                ForEach(model.remoteConnections) { connection in
                    RemoteConnectionSettingsRow(connectionID: connection.id)
                }
            }
        }
    }
}

private struct RemoteConnectionSettingsRow: View {
    @Environment(AppModel.self) private var model
    let connectionID: UUID
    @State private var nickname = ""
    @State private var confirmRemoval = false
    @State private var confirmInstall = false
    @State private var installHarness: String?

    private var connection: RemoteConnection? {
        model.remoteConnections.first { $0.id == connectionID }
    }

    var body: some View {
        if let connection {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(connection.displayName).font(.headline)
                        Text(connection.sshAlias)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle()
                        .fill(statusColor(connection.status))
                        .frame(width: 8, height: 8)
                    Text(statusLabel(connection.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    TextField("Nickname", text: $nickname)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            model.setRemoteNickname(connectionID, nickname: nickname)
                        }
                    Button("Save name") {
                        model.setRemoteNickname(connectionID, nickname: nickname)
                    }
                    if connection.status == .connected {
                        Button("Disconnect") {
                            Task { await model.disconnectRemote(connectionID) }
                        }
                    } else {
                        Button("Connect") {
                            Task { await model.connectRemote(connectionID) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            connection.status == .connecting
                                || connection.status == .installing)
                    }
                }
                Toggle(
                    "Connect automatically when the app opens",
                    isOn: Binding(
                        get: { connection.enabled },
                        set: { model.setRemoteEnabled(connectionID, enabled: $0) }))
                    .toggleStyle(.switch)
                HStack {
                    Button("Harness Doctor") {
                        Task { await model.runRemoteHarnessDoctor(connectionID: connectionID) }
                    }
                    Menu("Install harness") {
                        ForEach(["claude", "codex", "cursor", "opencode"], id: \.self) {
                            harness in
                            Button(harness.capitalized) { installHarness = harness }
                        }
                    }
                    Button("Install runtime…") { confirmInstall = true }
                    Menu("Login") {
                        Button("Claude") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .claude)
                            }
                        }
                        Button("Codex (device code)") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .codex)
                            }
                        }
                        Button("Cursor") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .cursor)
                            }
                        }
                    }
                    Spacer()
                    Button("Remove…", role: .destructive) { confirmRemoval = true }
                }
                if let runtime = connection.runtimeVersion {
                    Text("Remote runtime \(runtime)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !connection.savedProjects.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text("Saved projects").font(.caption.weight(.semibold))
                        ForEach(connection.savedProjects, id: \.self) { path in
                            Text(path)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                if let message = model.remoteConnectionMessages[connectionID] {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(connection.status == .failed ? .orange : .secondary)
                        .textSelection(.enabled)
                }
            }
            .padding()
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .onAppear { nickname = connection.nickname ?? "" }
            .confirmationDialog(
                "Install the signed Claudexor runtime on \(connection.displayName)?",
                isPresented: $confirmInstall
            ) {
                Button("Install") {
                    Task { await model.installRemoteRuntime(connectionID: connectionID) }
                }
            } message: {
                Text(
                    "It installs without sudo under ~/.claudexor/remote/versions and atomically updates the current pointer.")
            }
            .confirmationDialog(
                "Remove \(connection.displayName)?",
                isPresented: $confirmRemoval
            ) {
                Button("Remove connection", role: .destructive) {
                    Task { await model.removeRemoteConnection(connectionID) }
                }
            } message: {
                Text(
                    "This removes local connection metadata and cached thread titles. Nothing is deleted from the server.")
            }
            .confirmationDialog(
                "Install \(installHarness?.capitalized ?? "harness")?",
                isPresented: Binding(
                    get: { installHarness != nil },
                    set: { if !$0 { installHarness = nil } })
            ) {
                Button("Run installer") {
                    guard let harness = installHarness else { return }
                    installHarness = nil
                    Task {
                        await model.startRemoteHarnessInstall(
                            connectionID: connectionID, harness: harness)
                    }
                }
                Button("Cancel", role: .cancel) { installHarness = nil }
            } message: {
                let disclosure = installerDisclosure(installHarness ?? "")
                Text(
                    "Command: \(disclosure.command)\nInstall location: \(disclosure.location)\n\nThe command runs on \(connection.displayName) in the embedded terminal. Claudexor runs Harness Doctor afterward.")
            }
        }
    }

    private func statusLabel(_ state: RemoteConnectionState) -> String {
        switch state {
        case .offline: "Offline"
        case .connecting: "Connecting"
        case .needsInteraction: "Needs authentication"
        case .installing: "Installing"
        case .connected: "Connected"
        case .failed: "Failed"
        }
    }

    private func statusColor(_ state: RemoteConnectionState) -> SwiftUI.Color {
        switch state {
        case .connected: Theme.status(.positive)
        case .connecting, .installing: Theme.status(.caution)
        case .needsInteraction, .failed: SwiftUI.Color.orange
        case .offline: SwiftUI.Color.secondary
        }
    }

    private func installerDisclosure(_ harness: String) -> (
        command: String, location: String
    ) {
        switch harness {
        case "claude":
            (
                "npm install --global --prefix ~/.claudexor/remote/vendor @anthropic-ai/claude-code@latest",
                "~/.claudexor/remote/vendor/bin")
        case "codex":
            (
                "npm install --global --prefix ~/.claudexor/remote/vendor @openai/codex@latest",
                "~/.claudexor/remote/vendor/bin")
        case "opencode":
            (
                "npm install --global --prefix ~/.claudexor/remote/vendor opencode-ai@latest",
                "~/.claudexor/remote/vendor/bin")
        case "cursor":
            (
                "curl https://cursor.com/install -fsS | bash",
                "~/.local/bin (or ~/.cursor/bin)")
        default:
            ("", "")
        }
    }
}
