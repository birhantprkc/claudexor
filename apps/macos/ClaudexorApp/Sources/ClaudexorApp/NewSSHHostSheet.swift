import AppKit
import ClaudexorKit
import SwiftUI

/// "New SSH Host" — the scoped transactional sheet behind the Connections
/// `New SSH Host…` button (sheets are the app's idiom for a short multi-field
/// task with a filesystem consequence; a disclosure hid this primary action
/// behind a 12px chevron).
///
/// Contract:
/// - live, FIELD-LOCAL validation: required errors appear only after the field
///   is touched (or a writer refusal), a stale error clears on edit, and typed
///   writer refusals land under their owning field (`SSHConfigWriter.owningField`);
///   only I/O failures render at form level;
/// - an always-visible preview of the exact block, rendered by the WRITER
///   (`SSHConfigWriter.render`) — never re-formatted in SwiftUI;
/// - `Create & Add` performs the whole outcome in one step: write the block,
///   rescan, create the `RemoteConnection`. Return submits when valid; Escape
///   cancels. Success closes the sheet and hands the receipt to Connections.
struct NewSSHHostSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: (SSHHostCreationReceipt) -> Void

    @State private var draft = SSHHostDraft()
    @State private var touched: Set<SSHHostDraftField> = []
    @State private var writerErrors: [SSHHostDraftField: String] = [:]
    @State private var formFailure: String?
    @FocusState private var focusedField: SSHHostDraftField?

    private static let labelWidth: CGFloat = 84

    private var knownAliases: Set<String> { Set(model.sshHostScan.hosts.map(\.alias)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("New SSH Host").font(.title3.weight(.semibold))
                    Text(
                        "Writes a plain Host entry to ~/.ssh/config. Keys and passwords stay with OpenSSH — Claudexor never stores them.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    fieldRow(.alias, label: "Alias", placeholder: "prod", keyPath: \.alias)
                    fieldRow(
                        .hostName, label: "Host name", placeholder: "server.example.com",
                        keyPath: \.hostName)
                    fieldRow(
                        .user, label: "User", placeholder: "Optional, e.g. deploy", keyPath: \.user)
                    fieldRow(.port, label: "Port", placeholder: "Default: 22", keyPath: \.port)
                    identityFileRow
                }
                previewSection
                if let formFailure {
                    // Only I/O/backup/write failures land here; every typed
                    // refusal is mapped to its owning field above.
                    Text(formFailure)
                        .font(.caption)
                        .foregroundStyle(Theme.status(.negative))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(Theme.Spacing.xl)
            Divider().overlay(Theme.separator)
            HStack(spacing: Theme.Spacing.sm) {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create & Add") { createAndAdd() }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
                    .help(
                        isValid
                            ? "Append this Host block to ~/.ssh/config and add the connection."
                            : "Alias and host name are required; fix any field errors first.")
            }
            .padding(Theme.Spacing.lg)
        }
        .frame(width: 500)
        .textSelection(.enabled)
        .onChange(of: focusedField) { previous, _ in
            // Leaving a field marks it touched, so required-field errors appear
            // after real interaction, not on a freshly opened sheet.
            if let previous { touched.insert(previous) }
        }
    }

    // MARK: Rows

    private func fieldRow(
        _ field: SSHHostDraftField,
        label: String,
        placeholder: String,
        keyPath: WritableKeyPath<SSHHostDraft, String>
    ) -> some View {
        OptionRow(label: label, labelWidth: Self.labelWidth) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                TextField(placeholder, text: binding(keyPath, field))
                    .textFieldStyle(.roundedBorder)
                    // Port stays string-backed (a formatter mangles blank and
                    // in-progress values); monospaced digits keep it legible.
                    .font(field == .port ? .body.monospacedDigit() : .body)
                    .focused($focusedField, equals: field)
                errorText(field)
            }
        }
    }

    private var identityFileRow: some View {
        OptionRow(label: "Identity file", labelWidth: Self.labelWidth) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                HStack(spacing: Theme.Spacing.sm) {
                    TextField(
                        "Optional, e.g. ~/.ssh/id_ed25519",
                        text: binding(\.identityFile, .identityFile))
                        .textFieldStyle(.roundedBorder)
                        .focused($focusedField, equals: .identityFile)
                    Button {
                        pickIdentityFile()
                    } label: {
                        Label("Choose…", systemImage: "folder")
                    }
                    .buttonStyle(.bordered)
                    .help("Pick a private key; only its PATH is written, never its contents.")
                }
                errorText(.identityFile)
            }
        }
    }

    @ViewBuilder private func errorText(_ field: SSHHostDraftField) -> some View {
        if let message = displayedError(field) {
            Text(message)
                .font(.caption)
                .foregroundStyle(Theme.status(.negative))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Will append to ~/.ssh/config")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            // Writer-owned bytes: this preview and the actual append share
            // SSHConfigWriter.render — they cannot diverge.
            Text(SSHConfigWriter().render(draft))
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.sm)
                .codeSurface(Theme.Radius.control)
            Text(
                "Claudexor appends this block without rewriting existing entries. If the file exists, it creates a timestamped backup first.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Validation state

    private func binding(
        _ keyPath: WritableKeyPath<SSHHostDraft, String>, _ field: SSHHostDraftField
    ) -> Binding<String> {
        Binding(
            get: { draft[keyPath: keyPath] },
            set: { value in
                draft[keyPath: keyPath] = value
                touched.insert(field)
                // Editing a field clears ITS stale errors (live + mapped).
                writerErrors[field] = nil
                formFailure = nil
            })
    }

    private func displayedError(_ field: SSHHostDraftField) -> String? {
        if let mapped = writerErrors[field] { return mapped }
        guard touched.contains(field) else { return nil }
        return SSHConfigWriter.liveFieldError(
            field, draft: draft, knownAliases: field == .alias ? knownAliases : [])
    }

    private var isValid: Bool {
        writerErrors.isEmpty
            && SSHHostDraftField.allCases.allSatisfy { field in
                SSHConfigWriter.liveFieldError(
                    field, draft: draft, knownAliases: field == .alias ? knownAliases : []) == nil
            }
    }

    // MARK: Actions

    private func createAndAdd() {
        do {
            let receipt = try model.createSSHHostConnection(draft)
            onCreated(receipt)
            dismiss()
        } catch let error as SSHConfigWriteError {
            if let field = SSHConfigWriter.owningField(of: error) {
                writerErrors[field] = error.localizedDescription
            } else {
                formFailure = error.localizedDescription
            }
        } catch {
            formFailure = error.localizedDescription
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
        touched.insert(.identityFile)
        writerErrors[.identityFile] = nil
    }
}
