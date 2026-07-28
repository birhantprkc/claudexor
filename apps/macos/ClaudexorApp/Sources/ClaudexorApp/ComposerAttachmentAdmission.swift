import Foundation

struct HarnessAttachmentInput: Hashable {
    var kind: String
    var mimeTypes: [String]
    var maxBytes: Int
    var maxCount: Int
    var transport: String
}

struct ComposerAttachmentDescriptor: Hashable {
    var id: String
    var kind: String
    var mime: String
    var name: String
    var sizeBytes: Int
}

struct ComposerAttachmentLane: Hashable {
    var id: String
    var inputs: [HarnessAttachmentInput]
}

enum ComposerAttachmentPoolMode: Equatable { case auto, explicit }
enum ComposerAttachmentOutcome: Equatable { case admitted, degraded, refused }
enum ComposerAttachmentRefusalReason: String, Equatable {
    case admitted
    case unsupportedInput = "unsupported_input"
    case maxBytesExceeded = "max_bytes_exceeded"
    case maxCountExceeded = "max_count_exceeded"
}

struct ComposerAttachmentLaneAdmission: Equatable {
    var laneID: String
    var admitted: Bool
    var reason: ComposerAttachmentRefusalReason
    var message: String?
}

struct ComposerAttachmentPoolAdmission: Equatable {
    var outcome: ComposerAttachmentOutcome
    var admittedLaneIDs: [String]
    var rejected: [ComposerAttachmentLaneAdmission]
    var message: String?

    var canSend: Bool { outcome != .refused }
}

enum ComposerAttachmentAdmission {
    /// Auto may discard unavailable candidates before launch. An explicit pool
    /// is an exact user request, so every selected lane remains represented;
    /// missing manifest truth becomes an empty declaration and fails closed.
    static func projectLane(
        id: String,
        inputs: [HarnessAttachmentInput]?,
        available: Bool,
        poolMode: ComposerAttachmentPoolMode
    ) -> ComposerAttachmentLane? {
        if poolMode == .auto && !available { return nil }
        return .init(id: id, inputs: inputs ?? [])
    }

    static func resolveLane(
        lane: ComposerAttachmentLane,
        attachments: [ComposerAttachmentDescriptor]
    ) -> ComposerAttachmentLaneAdmission {
        for attachment in attachments {
            let matching = lane.inputs.filter {
                $0.kind == attachment.kind && $0.mimeTypes.contains(attachment.mime)
            }
            guard !matching.isEmpty else {
                return .init(
                    laneID: lane.id,
                    admitted: false,
                    reason: .unsupportedInput,
                    message: "\(lane.id) does not accept \(attachment.kind) \(attachment.mime)."
                )
            }
            let sizeCompatible = matching.filter { attachment.sizeBytes <= $0.maxBytes }
            guard !sizeCompatible.isEmpty else {
                let limit = matching.map(\.maxBytes).max() ?? 0
                return .init(
                    laneID: lane.id,
                    admitted: false,
                    reason: .maxBytesExceeded,
                    message: "\(lane.id) limits \(attachment.mime) to \(limit) bytes."
                )
            }
            let countCompatible = sizeCompatible.contains { input in
                attachments.filter {
                    $0.kind == input.kind && input.mimeTypes.contains($0.mime)
                }.count <= input.maxCount
            }
            guard countCompatible else {
                let limit = sizeCompatible.map(\.maxCount).max() ?? 0
                return .init(
                    laneID: lane.id,
                    admitted: false,
                    reason: .maxCountExceeded,
                    message: "\(lane.id) accepts at most \(limit) matching attachment(s)."
                )
            }
        }
        return .init(laneID: lane.id, admitted: true, reason: .admitted, message: nil)
    }

    static func resolve(
        poolMode: ComposerAttachmentPoolMode,
        attachments: [ComposerAttachmentDescriptor],
        lanes: [ComposerAttachmentLane]
    ) -> ComposerAttachmentPoolAdmission {
        var seen: Set<String> = []
        let uniqueLanes = lanes.filter { seen.insert($0.id).inserted }
        if !attachments.isEmpty && uniqueLanes.isEmpty {
            return .init(
                outcome: .refused,
                admittedLaneIDs: [],
                rejected: [],
                message: "No available harness lane can receive the selected attachments."
            )
        }
        let admissions = uniqueLanes.map { resolveLane(lane: $0, attachments: attachments) }
        let rejected = admissions.filter { !$0.admitted }
        let admitted = admissions.filter(\.admitted).map(\.laneID)
        guard !rejected.isEmpty else {
            return .init(outcome: .admitted, admittedLaneIDs: admitted, rejected: [], message: nil)
        }
        if poolMode == .explicit || admitted.isEmpty {
            let lanes = rejected.map(\.laneID).joined(separator: ", ")
            return .init(
                outcome: .refused,
                admittedLaneIDs: [],
                rejected: rejected,
                message: "Attachments are incompatible with \(lanes). Change the explicit pool or remove them."
            )
        }
        let lanes = rejected.map(\.laneID).joined(separator: ", ")
        return .init(
            outcome: .degraded,
            admittedLaneIDs: admitted,
            rejected: rejected,
            message: "Auto will omit attachment-incompatible lanes before launch: \(lanes)."
        )
    }
}
