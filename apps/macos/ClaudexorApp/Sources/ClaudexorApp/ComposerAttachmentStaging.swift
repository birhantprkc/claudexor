import Darwin
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

struct ComposerAttachmentOpenedFile {
    var metadata: ComposerAttachmentFileMetadata
    var read: (Int) throws -> Data
    var unchanged: () throws -> Bool
    var close: () -> Void
}

private struct ComposerAttachmentFileFingerprint: Equatable {
    var device: UInt64
    var inode: UInt64
    var sizeBytes: Int
    var modificationSeconds: Int64
    var modificationNanoseconds: Int64
    var changeSeconds: Int64
    var changeNanoseconds: Int64
    var linkCount: UInt64
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
    typealias FileOpener = (URL) throws -> ComposerAttachmentOpenedFile

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
            open: openFile
        )
    }

    static func stage(
        sources: [ComposerAttachmentSource],
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane],
        metadata: @escaping MetadataProvider,
        load: @escaping DataLoader
    ) -> ComposerAttachmentStagingResult {
        stage(
            sources: sources,
            existing: existing,
            poolMode: poolMode,
            lanes: lanes,
            open: { url in
                let initial = try metadata(url)
                return ComposerAttachmentOpenedFile(
                    metadata: initial,
                    read: { expectedSize in try load(url, expectedSize) },
                    unchanged: { try metadata(url) == initial },
                    close: {}
                )
            }
        )
    }

    static func stage(
        sources: [ComposerAttachmentSource],
        existing: [ComposerAttachmentDescriptor],
        poolMode: ComposerAttachmentPoolMode,
        lanes: [ComposerAttachmentLane],
        open: FileOpener
    ) -> ComposerAttachmentStagingResult {
        var result = ComposerAttachmentStagingResult()
        var prospective = existing

        for (index, source) in sources.enumerated() {
            let opened: ComposerAttachmentOpenedFile
            do {
                opened = try open(source.url)
            } catch {
                result.notices.append("Skipped \(source.name): \(message(for: error)).")
                continue
            }
            defer { opened.close() }
            let file = opened.metadata
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
                let data = try opened.read(file.sizeBytes)
                guard data.count == file.sizeBytes else {
                    result.notices.append(
                        "Skipped \(source.name): the file changed while it was being read."
                    )
                    continue
                }
                guard try opened.unchanged() else {
                    result.notices.append(
                        "Skipped \(source.name): the file changed while it was being read."
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

    /// Open, classify, admit, and read one descriptor. The path is checked only
    /// for final identity; the bytes and both fingerprints share this exact fd.
    static func openFile(_ url: URL) throws -> ComposerAttachmentOpenedFile {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw ComposerAttachmentStagingError.couldNotRead }
        do {
            let initial = try fingerprint(of: descriptor)
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            return ComposerAttachmentOpenedFile(
                metadata: .init(sizeBytes: initial.sizeBytes),
                read: { expectedSize in try loadBounded(handle, expectedSize: expectedSize) },
                unchanged: {
                    try fingerprint(of: descriptor) == initial
                        && pathIdentity(at: url) == (initial.device, initial.inode)
                },
                close: { try? handle.close() }
            )
        } catch {
            Darwin.close(descriptor)
            throw error
        }
    }

    private static func fingerprint(of descriptor: Int32) throws
        -> ComposerAttachmentFileFingerprint
    {
        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            throw ComposerAttachmentStagingError.couldNotRead
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
            throw ComposerAttachmentStagingError.notRegularFile
        }
        guard status.st_size >= 0, let sizeBytes = Int(exactly: status.st_size) else {
            throw ComposerAttachmentStagingError.missingSize
        }
        return ComposerAttachmentFileFingerprint(
            device: UInt64(status.st_dev),
            inode: UInt64(status.st_ino),
            sizeBytes: sizeBytes,
            modificationSeconds: Int64(status.st_mtimespec.tv_sec),
            modificationNanoseconds: Int64(status.st_mtimespec.tv_nsec),
            changeSeconds: Int64(status.st_ctimespec.tv_sec),
            changeNanoseconds: Int64(status.st_ctimespec.tv_nsec),
            linkCount: UInt64(status.st_nlink)
        )
    }

    private static func pathIdentity(at url: URL) throws -> (UInt64, UInt64) {
        var status = stat()
        let result = url.path.withCString { stat($0, &status) }
        guard result == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        else {
            throw ComposerAttachmentStagingError.fileChanged
        }
        return (UInt64(status.st_dev), UInt64(status.st_ino))
    }

    /// Reads at most the descriptor size plus one byte. The extra byte detects
    /// growth; a short read detects truncation. No separate client limit
    /// competes with the finite per-harness manifest limit that admitted it.
    private static func loadBounded(_ handle: FileHandle, expectedSize: Int) throws -> Data {
        var data = Data()
        let chunkSize = 64 * 1_024
        while data.count <= expectedSize {
            let remaining = expectedSize - data.count
            let requested = remaining >= chunkSize ? chunkSize : remaining + 1
            guard let chunk = try handle.read(upToCount: requested), !chunk.isEmpty else { break }
            data.append(chunk)
            if data.count > expectedSize {
                throw ComposerAttachmentStagingError.fileChanged
            }
        }
        guard data.count == expectedSize else {
            throw ComposerAttachmentStagingError.fileChanged
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
    case fileChanged
    case couldNotRead

    var message: String {
        switch self {
        case .notRegularFile: return "it is not a regular file"
        case .missingSize: return "its size could not be determined"
        case .fileChanged: return "the file changed while it was being read"
        case .couldNotRead: return "the file could not be read"
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
