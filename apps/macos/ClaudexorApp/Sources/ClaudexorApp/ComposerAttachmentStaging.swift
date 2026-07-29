import Foundation
import UniformTypeIdentifiers

/// One file whose type is known before its bytes are loaded. Screen captures use
/// an explicit public name/type while picker sources derive both from the URL.
struct ComposerAttachmentSource: Equatable, Sendable {
    var url: URL
    var name: String
    var kind: String
    var mime: String

    static func pickedFile(_ url: URL) -> ComposerAttachmentSource {
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        return .init(
            url: url,
            name: url.lastPathComponent,
            kind: mime.hasPrefix("image/") ? "image" : "file",
            mime: mime
        )
    }

    static func screenshot(_ url: URL) -> ComposerAttachmentSource {
        .init(url: url, name: "screenshot.png", kind: "image", mime: "image/png")
    }
}

struct ComposerAttachmentFileMetadata: Equatable, Sendable {
    var sizeBytes: Int
}

struct ComposerAttachmentStagingResult: Equatable, Sendable {
    var attachments: [PendingAttachment] = []
    var notices: [String] = []

    var notice: String? {
        notices.isEmpty ? nil : notices.joined(separator: "\n")
    }
}

/// One immutable value crossing into detached file IO. Its canonical members are
/// value types composed only of strings, integers, arrays, and enums; unchecked
/// is limited to this boundary because their declarations live in another file.
struct ComposerAttachmentStagingRequest: Sendable {
    let sources: [ComposerAttachmentSource]
    fileprivate let existing: [ComposerAttachmentDescriptor]
    fileprivate let poolMode: ComposerAttachmentPoolMode
    fileprivate let lanes: [ComposerAttachmentLane]

    init(
        sources: [ComposerAttachmentSource],
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane]
    ) {
        self.sources = sources
        self.existing = existing
        self.poolMode = poolMode
        self.lanes = lanes
    }

    func replacingSources(_ sources: [ComposerAttachmentSource]) -> Self {
        .init(sources: sources, existing: existing, poolMode: poolMode, lanes: lanes)
    }
}

/// Admission-before-read staging. The harness manifest remains the only size,
/// count, and MIME authority; this layer merely applies it before allocating
/// file contents and verifies that the file did not change under the read.
enum ComposerAttachmentStager {
    typealias MetadataProvider = (URL) throws -> ComposerAttachmentFileMetadata
    typealias DataLoader = (URL, Int) throws -> Data

    static func stage(_ request: ComposerAttachmentStagingRequest) -> ComposerAttachmentStagingResult {
        stage(
            sources: request.sources,
            existing: request.existing,
            poolMode: request.poolMode,
            lanes: request.lanes
        )
    }

    static func stage(
        sources: [ComposerAttachmentSource],
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane]
    ) -> ComposerAttachmentStagingResult {
        stage(
            sources: sources,
            existing: existing,
            poolMode: poolMode,
            lanes: lanes,
            metadata: fileMetadata,
            load: loadBounded
        )
    }

    static func stage(
        sources: [ComposerAttachmentSource],
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane],
        metadata: MetadataProvider,
        load: DataLoader
    ) -> ComposerAttachmentStagingResult {
        var result = ComposerAttachmentStagingResult()
        var prospective = existing

        for (index, source) in sources.enumerated() {
            let file: ComposerAttachmentFileMetadata
            do {
                file = try metadata(source.url)
            } catch {
                result.notices.append("Skipped \(source.name): \(message(for: error)).")
                continue
            }
            guard file.sizeBytes >= 0 else {
                result.notices.append("Skipped \(source.name): its size could not be determined.")
                continue
            }

            let descriptor = ComposerAttachmentDescriptor(
                id: "staged-\(index)-\(source.url.standardizedFileURL.path)",
                kind: source.kind,
                mime: source.mime,
                name: source.name,
                sizeBytes: file.sizeBytes
            )
            let admission = ComposerAttachmentAdmission.resolve(
                poolMode: poolMode,
                attachments: prospective + [descriptor],
                lanes: lanes
            )
            guard admission.canSend else {
                result.notices.append(
                    "Skipped \(source.name): \(refusalMessage(admission))"
                )
                continue
            }

            do {
                let data = try load(source.url, file.sizeBytes)
                guard data.count == file.sizeBytes else {
                    result.notices.append(
                        "Skipped \(source.name): the file changed size while it was being read."
                    )
                    continue
                }
                let current = try metadata(source.url)
                guard current == file else {
                    result.notices.append(
                        "Skipped \(source.name): the file changed size while it was being read."
                    )
                    continue
                }
                result.attachments.append(PendingAttachment(
                    kind: source.kind,
                    mime: source.mime,
                    name: source.name,
                    data: data
                ))
                prospective.append(descriptor)
            } catch {
                result.notices.append("Skipped \(source.name): \(message(for: error)).")
            }
        }
        return result
    }

    /// A same-generation picker and capture may finish in either order. Reapply
    /// the exact admission against live attachments before appending so both can
    /// proceed concurrently without publishing an over-count result.
    static func revalidated(
        _ staged: ComposerAttachmentStagingResult,
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane]
    ) -> ComposerAttachmentStagingResult {
        var result = ComposerAttachmentStagingResult(notices: staged.notices)
        var prospective = existing
        for attachment in staged.attachments {
            let descriptor = ComposerAttachmentDescriptor(
                id: attachment.id.uuidString,
                kind: attachment.kind,
                mime: attachment.mime,
                name: attachment.name,
                sizeBytes: attachment.data.count
            )
            let admission = ComposerAttachmentAdmission.resolve(
                poolMode: poolMode,
                attachments: prospective + [descriptor],
                lanes: lanes
            )
            guard admission.canSend else {
                result.notices.append(
                    "Skipped \(attachment.name): \(refusalMessage(admission))"
                )
                continue
            }
            result.attachments.append(attachment)
            prospective.append(descriptor)
        }
        return result
    }

    private static func fileMetadata(_ url: URL) throws -> ComposerAttachmentFileMetadata {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else {
            throw ComposerAttachmentStagingError.notRegularFile
        }
        guard let size = values.fileSize, size >= 0 else {
            throw ComposerAttachmentStagingError.missingSize
        }
        return .init(sizeBytes: size)
    }

    /// Reads at most the stat size plus one byte. The extra byte detects growth;
    /// a short read detects truncation. No separate client limit competes with
    /// the finite per-harness manifest limit that admitted the descriptor.
    private static func loadBounded(_ url: URL, expectedSize: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        let chunkSize = 64 * 1_024
        while data.count <= expectedSize {
            let remaining = expectedSize - data.count
            let requested = remaining >= chunkSize ? chunkSize : remaining + 1
            guard let chunk = try handle.read(upToCount: requested), !chunk.isEmpty else { break }
            data.append(chunk)
            if data.count > expectedSize {
                throw ComposerAttachmentStagingError.sizeChanged
            }
        }
        guard data.count == expectedSize else {
            throw ComposerAttachmentStagingError.sizeChanged
        }
        return data
    }

    private static func message(for error: Error) -> String {
        if let error = error as? ComposerAttachmentStagingError {
            return error.message
        }
        return "the file could not be read"
    }

    private static func refusalMessage(_ admission: ComposerAttachmentPoolAdmission) -> String {
        let exact = admission.rejected.compactMap(\.message).joined(separator: " ")
        return exact.isEmpty
            ? (admission.message ?? "No selected harness lane accepts it.")
            : exact
    }
}

private enum ComposerAttachmentStagingError: Error {
    case notRegularFile
    case missingSize
    case sizeChanged

    var message: String {
        switch self {
        case .notRegularFile: return "it is not a regular file"
        case .missingSize: return "its size could not be determined"
        case .sizeChanged: return "the file changed size while it was being read"
        }
    }
}

struct ComposerAttachmentOperationLease: Equatable {
    fileprivate var token: UUID
    fileprivate var selectionGeneration: UInt64
    fileprivate var origin: ComposerSelectionContext
}

/// Parallel operations share a generation, while every explicit selection
/// change advances it. Checking both generation and exact context rejects ABA
/// (A -> B -> A) as well as ordinary late completion into another composer.
struct ComposerAttachmentOperationCoordinator: Equatable {
    private var selectionGeneration: UInt64 = 0
    private var activeTokens: Set<UUID> = []

    var inFlightCount: Int { activeTokens.count }

    mutating func begin(from origin: ComposerSelectionContext) -> ComposerAttachmentOperationLease {
        let lease = ComposerAttachmentOperationLease(
            token: UUID(), selectionGeneration: selectionGeneration, origin: origin)
        activeTokens.insert(lease.token)
        return lease
    }

    mutating func finish(_ lease: ComposerAttachmentOperationLease) {
        activeTokens.remove(lease.token)
    }

    mutating func invalidateSelection() {
        selectionGeneration &+= 1
        activeTokens.removeAll()
    }

    mutating func cancelAll() {
        selectionGeneration &+= 1
        activeTokens.removeAll()
    }

    func owns(_ lease: ComposerAttachmentOperationLease, current: ComposerSelectionContext) -> Bool {
        activeTokens.contains(lease.token)
            && lease.selectionGeneration == selectionGeneration
            && lease.origin == current
    }

    func owned<Result>(
        _ result: Result,
        for lease: ComposerAttachmentOperationLease,
        current: ComposerSelectionContext
    ) -> Result? {
        owns(lease, current: current) ? result : nil
    }
}

enum ComposerAttachmentSelectionPolicy {
    static func retained(
        _ attachments: [PendingAttachment],
        after transition: ComposerSelectionTransition
    ) -> [PendingAttachment] {
        transition == .explicitSelection ? [] : attachments
    }
}
