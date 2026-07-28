import ClaudexorKit
import AppKit
import SwiftTerm
import SwiftUI
import WebKit
import ImageIO

/// SwiftTerm is only the terminal emulator. The child process remains the
/// system `/usr/bin/ssh`, so OpenSSH keeps ownership of auth and host policy.
struct EmbeddedSSHTerminal: NSViewRepresentable {
    let invocation: SSHInvocation
    var onExit: @MainActor @Sendable (Int32) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(onExit: onExit) }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let terminal = LocalProcessTerminalView(frame: .zero)
        terminal.processDelegate = context.coordinator
        terminal.startProcess(
            executable: invocation.executable,
            args: invocation.arguments,
            environment: nil,
            execName: "ssh",
            currentDirectory: nil)
        return terminal
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {}

    static func dismantleNSView(
        _ nsView: LocalProcessTerminalView,
        coordinator: Coordinator
    ) {
        if nsView.process.running { nsView.terminate() }
    }

    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        let onExit: @MainActor @Sendable (Int32) -> Void
        private var delivered = false

        init(onExit: @escaping @MainActor @Sendable (Int32) -> Void) {
            self.onExit = onExit
        }
        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func processTerminated(source: TerminalView, exitCode: Int32?) {
            guard !delivered else { return }
            delivered = true
            let code = exitCode ?? -1
            let callback = onExit
            Task { @MainActor in callback(code) }
        }
    }
}

struct RemoteTerminalSheet: View {
    @Environment(AppModel.self) private var model
    let request: RemoteTerminalSheetRequest
    let dismiss: @MainActor () -> Void
    @State private var exitCode: Int32?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(request.title, systemImage: "terminal")
                    .font(.headline)
                Spacer()
                if let exitCode {
                    Text(exitCode == 0 ? "Finished" : "Exited \(exitCode)")
                        .font(.caption)
                        .foregroundStyle(
                            exitCode == 0
                                ? SwiftUI.Color.secondary : SwiftUI.Color.orange)
                }
                Button("Done") { dismiss() }
                    .disabled(exitCode == nil && request.purpose.blocksDismissalWhileRunning)
            }
            .padding()
            Divider()
            EmbeddedSSHTerminal(invocation: request.invocation) { code in
                exitCode = code
                if case .authentication(let connectionID, let generation) = request.purpose {
                    Task {
                        await model.finishInteractiveRemoteConnection(
                            connectionID, generation: generation, exitCode: code)
                    }
                } else if case .setup(let connectionID, _) = request.purpose {
                    Task { await model.runRemoteHarnessDoctor(connectionID: connectionID) }
                }
            }
        }
        .frame(minWidth: 760, minHeight: 520)
        .background(Color(nsColor: .textBackgroundColor))
        .interactiveDismissDisabled(
            exitCode == nil && request.purpose.blocksDismissalWhileRunning)
    }
}

struct RemoteDirectoryBrowser: View {
    @Environment(AppModel.self) private var model
    let request: RemoteDirectoryBrowserRequest
    @State private var listing: RemoteDirectoryListing?
    @State private var loading = false
    @State private var status: String?
    @State private var directPath = ""

    private var connection: RemoteConnection? {
        model.remoteConnections.first { $0.id == request.connectionID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label(
                    "Browse on \(connection?.displayName ?? "remote host")",
                    systemImage: "network")
                    .font(.headline)
                Spacer()
                Button("Cancel") { model.remoteDirectoryBrowser = nil }
                Button("Choose Folder") { chooseCurrent() }
                    .buttonStyle(.borderedProminent)
                    .disabled(listing == nil)
            }
            .padding()
            Divider()
            HStack {
                Button {
                    if let parent = listing?.parent {
                        Task { await load(parent) }
                    }
                } label: {
                    Label("Up", systemImage: "arrow.up")
                }
                .disabled(listing?.parent == nil || loading)
                TextField("Remote path", text: $directPath)
                    .font(.system(.body, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await load(directPath) } }
                Button("Go") { Task { await load(directPath) } }
                    .disabled(
                        loading
                            || directPath.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            ).isEmpty)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
            }
            .padding()
            if listing?.truncated == true {
                Label(
                    "This folder has more entries than can be shown. Enter an exact path above to continue.",
                    systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                    .padding(.bottom, Theme.Spacing.xs)
            }
            if let status {
                ContentUnavailableView(
                    "Could not list this folder",
                    systemImage: "exclamationmark.triangle",
                    description: Text(status))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(listing?.entries.filter(\.isDirectory) ?? []) { entry in
                    Button {
                        Task { await load(entry.path) }
                    } label: {
                        HStack {
                            Image(systemName: "folder")
                            Text(entry.name)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!entry.readable)
                }
            }
        }
        .frame(minWidth: 640, minHeight: 520)
        .task { await load(nil) }
    }

    private func load(_ path: String?) async {
        guard let client = model.gateway(for: .remote(request.connectionID)) else {
            status = "The SSH connection is offline."
            return
        }
        loading = true
        defer { loading = false }
        do {
            listing = try await client.listRemoteDirectory(path: path)
            directPath = listing?.path ?? directPath
            status = nil
        } catch {
            status = model.userMessage(for: error)
        }
    }

    private func chooseCurrent() {
        guard let path = listing?.path else { return }
        model.selectRemoteProject(connectionID: request.connectionID, path: path)
        model.remoteDirectoryBrowser = nil
    }
}

struct RemotePreviewSheet: View {
    @Environment(AppModel.self) private var model
    let request: RemotePreviewRequest

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(
                    "Remote preview · \(request.remotePort)",
                    systemImage: "safari")
                Spacer()
                Text("localhost:\(request.localPort)")
                    .font(.caption.monospaced())
                Button("Close") {
                    Task { await model.closeRemotePreview(request) }
                }
            }
            .padding()
            Divider()
            RemotePreviewWebView(
                url: URL(string: "http://127.0.0.1:\(request.localPort)")!)
        }
        .frame(minWidth: 900, minHeight: 650)
        .onDisappear { Task { await model.closeRemotePreview(request) } }
    }
}

struct RemoteDeviceLoginSheet: View {
    @Environment(AppModel.self) private var model
    let request: RemoteDeviceLoginRequest
    @State private var snapshot: SetupJobSnapshot?
    @State private var status: String?
    @State private var nativeSessionVerified = false
    @State private var harnessRoutable = false

    private var client: GatewayClient? {
        model.gateway(for: .remote(request.connectionID))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack {
                Label("Codex device login", systemImage: "person.badge.key")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("Close") { model.remoteDeviceLogin = nil }
            }
            if let disclosure = snapshot?.deviceCode {
                Text("Open this page in an isolated browser session, then enter the one-time code.")
                    .foregroundStyle(.secondary)
                HStack {
                    Text(disclosure.verificationUrl)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                    Button("Open") {
                        if let url = URL(string: disclosure.verificationUrl) {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
                if disclosure.hasUserCode {
                    HStack {
                        Text(disclosure.userCode)
                            .font(.system(size: 26, weight: .semibold, design: .monospaced))
                            .textSelection(.enabled)
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(
                                disclosure.userCode, forType: .string)
                        }
                    }
                }
            } else if snapshot?.job.isTerminal != true {
                ProgressView("Waiting for Codex to issue a device code…")
            }
            if let job = snapshot?.job {
                if remoteDeviceLoginRecoveredFromProtocolMismatch(
                    jobState: job.state,
                    selectionReason: job.authCapability?.receipt?.selectionReason,
                    effectiveRoute: job.authCapability?.receipt?.effective,
                    effectiveSource: job.authCapability?.receipt?.effectiveSource,
                    nativeSessionVerified: nativeSessionVerified,
                    harnessRoutable: harnessRoutable)
                {
                    Text("Codex is signed in and ready.")
                        .font(.callout)
                        .foregroundStyle(Theme.status(.positive))
                    Text(
                        "Harness Doctor confirmed the native session. "
                            + "An extra compatibility check returned an outdated protocol result.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(job.message)
                        .font(.callout)
                        .foregroundStyle(job.isTerminal && job.state != .succeeded
                            ? SwiftUI.Color.orange : SwiftUI.Color.secondary)
                }
                if job.isTerminal {
                    let verified = job.state == .succeeded
                        || remoteDeviceLoginRecoveredFromProtocolMismatch(
                            jobState: job.state,
                            selectionReason: job.authCapability?.receipt?.selectionReason,
                            effectiveRoute: job.authCapability?.receipt?.effective,
                            effectiveSource: job.authCapability?.receipt?.effectiveSource,
                            nativeSessionVerified: nativeSessionVerified,
                            harnessRoutable: harnessRoutable)
                    Label(
                        verified ? "Login verified" : "Login failed",
                        systemImage: verified
                            ? "checkmark.circle.fill" : "xmark.circle")
                        .foregroundStyle(verified
                            ? Theme.status(.positive) : SwiftUI.Color.orange)
                }
            }
            if let status {
                Text(status).font(.caption).foregroundStyle(.orange)
            }
            Spacer()
            HStack {
                Spacer()
                if snapshot?.job.canCancel == true {
                    Button("Cancel", role: .destructive) {
                        Task {
                            _ = try? await client?.cancelSetupJob(jobId: request.jobID)
                        }
                    }
                }
                Button(snapshot?.job.isTerminal == true ? "Done" : "Keep open") {
                    model.remoteDeviceLogin = nil
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(width: 560, height: 410)
        .task(id: request.jobID) {
            guard let client else {
                status = "The remote connection is offline."
                return
            }
            while !Task.isCancelled {
                do {
                    let current = try await client.setupJobSnapshot(jobId: request.jobID)
                    snapshot = current
                    status = nil
                    if current.job.isTerminal {
                        if let readiness = await model.refreshRemoteNativeLoginReadiness(
                            connectionID: request.connectionID,
                            harnessID: SetupHarness.codex.rawValue)
                        {
                            nativeSessionVerified = readiness.nativeSessionVerified
                            harnessRoutable = readiness.harnessRoutable
                        }
                        return
                    }
                } catch {
                    status = model.userMessage(for: error)
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

func remoteDeviceLoginRecoveredFromProtocolMismatch(
    jobState: SetupJobState,
    selectionReason: AuthCapabilitySelectionReason?,
    effectiveRoute: CredentialRoute?,
    effectiveSource: AuthSourceKind?,
    nativeSessionVerified: Bool,
    harnessRoutable: Bool
) -> Bool {
    jobState == .failed
        && selectionReason == .protocolViolation
        && effectiveRoute == .vendorNative
        && effectiveSource == .nativeSession
        && nativeSessionVerified
        && harnessRoutable
}

struct RemoteThreadTerminalView: View {
    @Environment(AppModel.self) private var model
    let repoRoot: String
    @State private var invocation: SSHInvocation?
    @State private var status: String?
    @State private var previewPort = "3000"

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack {
                TextField("Dev server port", text: $previewPort)
                    .frame(width: 120)
                Button {
                    if let port = Int(previewPort) {
                        Task { await model.openRemotePreview(remotePort: port) }
                    }
                } label: {
                    Label("Open preview", systemImage: "safari")
                }
                .disabled(Int(previewPort).map { !(1 ... 65_535).contains($0) } ?? true)
                Button {
                    Task { await model.openRemoteDaemonLog() }
                } label: {
                    Label("Daemon log", systemImage: "doc.text.magnifyingglass")
                }
                Spacer()
            }
            if let invocation {
                EmbeddedSSHTerminal(invocation: invocation) { code in
                    status = code == 0 ? "Shell closed." : "SSH exited with code \(code)."
                }
                .frame(minHeight: 360)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if let status {
                ContentUnavailableView(
                    "Terminal unavailable",
                    systemImage: "terminal",
                    description: Text(status))
                    .frame(maxWidth: .infinity, minHeight: 300)
            } else {
                ProgressView("Opening SSH shell…")
                    .frame(maxWidth: .infinity, minHeight: 300)
            }
        }
        .task(id: "\(model.selectedExecutionLocation.rawValue)|\(repoRoot)") {
            guard let connection = model.selectedRemoteConnection else {
                status = "This thread is not on an SSH host."
                return
            }
            do {
                invocation = try await model.sshConnectionManager
                    .terminalShellInvocation(connection, directory: repoRoot)
                status = nil
            } catch {
                status = error.localizedDescription
            }
        }
    }
}

struct RemoteScopedProjectImage: View {
    @Environment(AppModel.self) private var model
    let target: String
    let alt: String
    @State private var image: NSImage?
    @State private var status: String?

    private struct ImageBox: @unchecked Sendable { let image: NSImage }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 560, maxHeight: 340, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
                    .help(
                        "\(alt.isEmpty ? "Remote image" : alt) — \(target). The bytes were fetched through the scoped SSH control tunnel.")
            } else if let status {
                VStack(alignment: .leading, spacing: 2) {
                    Text("![\(alt)](\(target))").font(.caption.monospaced())
                    Label(status, systemImage: "eye.slash")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id: "\(model.selectedExecutionLocation.rawValue)|\(target)") {
            guard let reference = model.remoteProjectFileReference(target: target),
                  let client = model.gateway(for: model.selectedExecutionLocation)
            else {
                status = "Remote image path is outside this project's scope."
                return
            }
            do {
                let response = try await client.fetchProjectFile(
                    projectID: reference.projectID,
                    relativePath: reference.relativePath)
                guard response.contentType.hasPrefix("image/") else {
                    status = "The remote file is not an image."
                    return
                }
                let data = response.data
                let decoded = await Task.detached(priority: .userInitiated) {
                    Self.thumbnail(data)
                }.value
                guard let decoded else {
                    status = "The remote image could not be decoded."
                    return
                }
                image = decoded.image
                status = nil
            } catch {
                status = model.userMessage(for: error)
            }
        }
    }

    nonisolated private static func thumbnail(_ data: Data) -> ImageBox? {
        guard data.count <= 25 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                  source, 0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceThumbnailMaxPixelSize: 1_200,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                  ] as CFDictionary)
        else { return nil }
        return ImageBox(image: NSImage(cgImage: image, size: .zero))
    }
}

private struct RemotePreviewWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
