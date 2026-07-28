import SwiftUI
import AppKit
import ClaudexorKit
import UniformTypeIdentifiers

// MARK: - Composer attachments (files / images / screen capture)
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): staging,
// gating, and capture of composer attachments. Pure move — zero behavior change.

extension ThreadsScreen {
    // MARK: - Composer attachments (D)

    var composerAttachmentPoolMode: ComposerAttachmentPoolMode {
        model.effectiveEligiblePool.isEmpty ? .auto : .explicit
    }

    var composerAttachmentLanes: [ComposerAttachmentLane] {
        let poolMode = composerAttachmentPoolMode
        return effectiveIncludedFamilies.compactMap { family in
            ComposerAttachmentAdmission.projectLane(
                id: family.rawValue,
                inputs: model.harnessInfo(for: family)?.attachmentInputs,
                available: model.availability(for: family, mode: composerMode).available,
                poolMode: poolMode
            )
        }
    }

    var composerAttachmentDescriptors: [ComposerAttachmentDescriptor] {
        composerAttachments.map {
            .init(
                id: $0.id.uuidString,
                kind: $0.kind,
                mime: $0.mime,
                name: $0.name,
                sizeBytes: $0.data.count
            )
        }
    }

    var composerAttachmentAdmission: ComposerAttachmentPoolAdmission {
        ComposerAttachmentAdmission.resolve(
            poolMode: composerAttachmentPoolMode,
            attachments: composerAttachmentDescriptors,
            lanes: composerAttachmentLanes
        )
    }

    /// Before content is chosen, Attach is useful only when the selected pool
    /// has at least one finite input declaration (Auto) or every explicit lane
    /// has one. Exact MIME/size/count admission runs after staging.
    var fileAttachmentsAllowed: Bool {
        guard !composerAttachmentLanes.isEmpty else { return false }
        switch composerAttachmentPoolMode {
        case .auto: return composerAttachmentLanes.contains { !$0.inputs.isEmpty }
        case .explicit: return composerAttachmentLanes.allSatisfy { !$0.inputs.isEmpty }
        }
    }

    var captureAdmission: ComposerAttachmentPoolAdmission {
        ComposerAttachmentAdmission.resolve(
            poolMode: composerAttachmentPoolMode,
            attachments: [
                .init(id: "capture", kind: "image", mime: "image/png", name: "screenshot.png", sizeBytes: 0)
            ],
            lanes: composerAttachmentLanes
        )
    }

    var imageAttachmentsAllowed: Bool {
        !composerAttachmentLanes.isEmpty && captureAdmission.canSend
    }

    var attachButton: some View {
        Button { pickAttachments() } label: {
            Label("Attach files", systemImage: "paperclip")
                .labelStyle(.iconOnly)
                .imageScale(.medium)
                .foregroundStyle(fileAttachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!fileAttachmentsAllowed)
        // QA-003: an icon-only control needs an explicit, locale-independent
        // English NAME — otherwise the AX name falls back to the host-localized
        // `paperclip` SF Symbol description (`Вложенные Файлы`). `.help` stays the
        // separate consequence hint.
        .productControlAccessibility("Attach files")
        .help(attachButtonHelp)
    }

    private var attachButtonHelp: String {
        guard fileAttachmentsAllowed else {
            return composerAttachmentPoolMode == .explicit
                ? "Every explicitly selected harness must declare an attachment input. Change the pool first."
                : "No available harness declares attachment input support."
        }
        let context = composerMode == .plan
            ? "Attach files or images as read-only planning context"
            : "Attach files or images"
        return composerAttachmentPoolMode == .auto
            ? "\(context); Auto may omit incompatible lanes before launch."
            : "\(context); every explicit lane must accept the selected content."
    }

    var attachmentChips: some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(composerAttachments) { att in
                HStack(spacing: 4) {
                    Image(systemName: att.kind == "image" ? "photo" : "doc")
                    Text(att.name).lineLimit(1).truncationMode(.middle)
                    Button { composerAttachments.removeAll { $0.id == att.id } } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    // QA-003: name the icon-only remove control (else the AX name
                    // is the localized `xmark.circle.fill` description).
                    .accessibilityLabel("Remove attachment")
                    .help("Remove \(att.name)")
                }
                .font(.caption)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.08), in: Capsule())
            }
        }
    }

    /// Pick files via NSOpenPanel and stage their bytes outside the main actor.
    /// AppModel uploads and finalizes them before the turn sends resource ids.
    private func pickAttachments() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        Task {
            let loaded = await Task.detached(priority: .userInitiated) { () -> [PendingAttachment] in
                var attachments: [PendingAttachment] = []
                for url in urls {
                    guard let data = try? Data(contentsOf: url) else { continue }
                    let mime = Self.mimeType(for: url)
                    let isImage = mime.hasPrefix("image/")
                    attachments.append(PendingAttachment(
                        kind: isImage ? "image" : "file", mime: mime, name: url.lastPathComponent,
                        data: data))
                }
                return attachments
            }.value
            composerAttachments.append(contentsOf: loaded)
        }
    }

    nonisolated private static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension), let m = t.preferredMIMEType { return m }
        return "application/octet-stream"
    }

    var captureButton: some View {
        Button { captureScreenshot() } label: {
            Label("Capture screen region", systemImage: "camera.viewfinder")
                .labelStyle(.iconOnly)
                .imageScale(.medium)
                .foregroundStyle(imageAttachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!imageAttachmentsAllowed)
        // QA-003: stable English name for the icon-only capture control. A
        // disabled capture keeps its NAME and separately announces the vision-
        // capability reason via `.help` (the acceptance-criteria case).
        .productControlAccessibility("Capture screen region")
        .help(captureButtonHelp)
    }

    private var captureButtonHelp: String {
        guard imageAttachmentsAllowed else {
            return captureAdmission.message
                ?? "Screen captures need an available image-capable harness lane."
        }
        return composerAttachmentPoolMode == .auto && captureAdmission.outcome == .degraded
            ? "Capture a screen region; Auto will omit incompatible lanes before launch."
            : "Capture a screen region to attach (you pick the area)."
    }

    @ViewBuilder var composerAttachmentNotice: some View {
        if !composerAttachments.isEmpty,
           composerAttachmentAdmission.outcome == .degraded,
           let message = composerAttachmentAdmission.message {
            Label(message, systemImage: "arrow.triangle.branch")
                .font(.caption2)
                .foregroundStyle(Theme.status(.caution))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Grab a screen region via the system `screencapture` (interactive crosshair),
    /// off the main thread so the UI doesn't freeze during selection. macOS gates
    /// this behind Screen Recording permission; a denied/cancelled grab yields no
    /// attachment (honest — never a blank/fake image).
    private func captureScreenshot() {
        Task { @MainActor in
            if let att = await Self.runScreencapture() {
                composerAttachments.append(att)
            }
        }
    }

    private static func runScreencapture() async -> PendingAttachment? {
        await withCheckedContinuation { (cont: CheckedContinuation<PendingAttachment?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("claudexor-shot-\(UUID().uuidString).png")
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                proc.arguments = ["-i", "-x", tmp.path] // interactive region select, silent
                do { try proc.run(); proc.waitUntilExit() }
                catch { cont.resume(returning: nil); return }
                guard let data = try? Data(contentsOf: tmp), !data.isEmpty else {
                    cont.resume(returning: nil); return // cancelled or permission denied
                }
                try? FileManager.default.removeItem(at: tmp)
                cont.resume(returning: PendingAttachment(
                    kind: "image", mime: "image/png", name: "screenshot.png",
                    data: data))
            }
        }
    }
}
