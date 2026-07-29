import AppKit
import ClaudexorKit
import SwiftUI

struct ConnectionsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedAlias = ""
    @State private var showNewHostForm = false

    private var addableHosts: [SSHHost] {
        model.availableSSHHosts.filter { host in
            !model.remoteConnections.contains { $0.sshAlias == host.alias }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            // Same shell every other Settings section uses (SectionLabel on a
            // raised surface): this pane used to hand-roll a title2 header and
            // read as a different app.
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("SSH Connections", systemImage: "network")
                Text(
                    "Hosts come from ~/.ssh/config. Claudexor delegates keys, ssh-agent, known_hosts, MFA, ProxyJump, and ProxyCommand to /usr/bin/ssh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Wrap instead of clipping: this sentence is longer than the
                    // Settings column, and clipped text is a visual-QA blocker.
                    .fixedSize(horizontal: false, vertical: true)
                OptionRow(label: "SSH host", labelWidth: 72) {
                    Picker("SSH host", selection: $selectedAlias) {
                        Text(addableHosts.isEmpty ? "No hosts to add" : "Choose an alias").tag("")
                        ForEach(addableHosts) { host in
                            Text(host.alias).tag(host.alias)
                        }
                    }
                    .labelsHidden()
                    .frame(width: Theme.Layout.modelPickerWidth, alignment: .leading)
                    .disabled(addableHosts.isEmpty)
                    Button {
                        model.addRemoteConnection(alias: selectedAlias)
                        selectedAlias = ""
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(selectedAlias.isEmpty)
                    // A disabled control must say why it is disabled.
                    .help(
                        addableHosts.isEmpty
                            ? "Every concrete Host alias in ~/.ssh/config is already added."
                            : "Choose an alias first, then add it as an execution location.")
                    Button {
                        model.refreshSSHHosts()
                    } label: {
                        Label("Rescan", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .help("Re-read ~/.ssh/config.")
                }
                DisclosureGroup("Add a new host…", isExpanded: $showNewHostForm) {
                    NewSSHHostForm { alias in
                        selectedAlias = alias
                        showNewHostForm = false
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(Theme.separator, lineWidth: 1))

            if model.remoteConnections.isEmpty {
                // Empty states name the ACTION, not the constraint: both real
                // paths to a first host, with the pattern note secondary.
                ContentUnavailableView(
                    "No remote connections",
                    systemImage: "network.slash",
                    description: Text(
                        "Create one with “Add a new host…” above, or add a Host block to ~/.ssh/config yourself and press Rescan. Pattern hosts (wildcards) stay hidden — only concrete aliases can become connections."))
            } else {
                ForEach(model.remoteConnections) { connection in
                    RemoteConnectionSettingsRow(connectionID: connection.id)
                }
            }
        }
    }
}

/// "Add a new host…": writes exactly the `Host` block the user would type into
/// ~/.ssh/config, through the Kit writer's typed fences (duplicate/pattern
/// alias, injection-shaped value, bad port — all refused, all shown inline).
/// Success rescans and hands the fresh alias to the picker above.
private struct NewSSHHostForm: View {
    @Environment(AppModel.self) private var model
    let onCreated: (String) -> Void
    @State private var draft = SSHHostDraft()
    @State private var failure: String?

    private var requiredFieldsFilled: Bool {
        !draft.alias.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.hostName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(
                "Writes a plain Host entry to ~/.ssh/config (after a timestamped backup). Keys and passwords stay with OpenSSH — Claudexor never stores them.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            OptionRow(label: "Alias", labelWidth: 72) {
                TextField("for example prod", text: $draft.alias)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Theme.Layout.modelPickerWidth)
            }
            OptionRow(label: "Host name", labelWidth: 72) {
                TextField("server.example.com", text: $draft.hostName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Theme.Layout.modelPickerWidth)
            }
            OptionRow(label: "User", labelWidth: 72) {
                TextField("Optional", text: $draft.user)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Theme.Layout.modelPickerWidth)
            }
            OptionRow(label: "Port", labelWidth: 72) {
                TextField("22", text: $draft.port)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Theme.Layout.modelPickerWidth)
            }
            OptionRow(label: "Identity file", labelWidth: 72) {
                TextField("Optional key path", text: $draft.identityFile)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Theme.Layout.modelPickerWidth)
                Button {
                    pickIdentityFile()
                } label: {
                    Label("Choose…", systemImage: "folder")
                }
                .buttonStyle(.bordered)
                .help("Pick a private key; only its PATH is written, never its contents.")
            }
            OptionRow(label: "", labelWidth: 72) {
                Button {
                    save()
                } label: {
                    Label("Save host", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .disabled(!requiredFieldsFilled)
                .help(
                    requiredFieldsFilled
                        ? "Append this Host block to ~/.ssh/config."
                        : "Alias and host name are required.")
            }
            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, Theme.Spacing.sm)
    }

    private func save() {
        do {
            let receipt = try model.addSSHConfigHost(draft)
            failure = nil
            draft = SSHHostDraft()
            onCreated(receipt.alias)
        } catch {
            // The writer's refusals are typed and user-legible — show them
            // verbatim, never swallow them.
            failure = error.localizedDescription
        }
    }

    private func pickIdentityFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose Identity File"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        // Identity keys live in the hidden ~/.ssh directory.
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(
            fileURLWithPath: NSString(string: "~/.ssh").expandingTildeInPath, isDirectory: true)
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        draft.identityFile = url.path
    }
}

private struct RemoteConnectionSettingsRow: View {
    @Environment(AppModel.self) private var model
    let connectionID: UUID
    @State private var nickname = ""
    @State private var confirmRemoval = false
    @State private var confirmInstall = false

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
                        // ssh failure text is server-influenced and arbitrarily
                        // long; wrap it rather than clipping the one line that
                        // explains why a connection failed.
                        .fixedSize(horizontal: false, vertical: true)
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
}
