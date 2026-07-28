import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ComposerAttachmentAdmissionTests {
    private let textInput = HarnessAttachmentInput(
        kind: "file", mimeTypes: ["text/plain"], maxBytes: 20, maxCount: 1,
        transport: "text_inline"
    )
    private let attachment = ComposerAttachmentDescriptor(
        id: "a1", kind: "file", mime: "text/plain", name: "notes.txt", sizeBytes: 12
    )

    @Test func explicitMixedPoolRefusesBeforeSend() {
        let result = ComposerAttachmentAdmission.resolve(
            poolMode: .explicit,
            attachments: [attachment],
            lanes: [
                .init(id: "claude", inputs: [textInput]),
                .init(id: "cursor", inputs: []),
            ]
        )
        #expect(result.outcome == .refused)
        #expect(result.admittedLaneIDs.isEmpty)
        #expect(result.rejected.map(\.laneID) == ["cursor"])
    }

    @Test func explicitUnavailableLaneWithoutManifestTruthStaysInPoolAndFailsClosed() {
        let lanes = [
            ComposerAttachmentAdmission.projectLane(
                id: "claude", inputs: [textInput], available: true, poolMode: .explicit
            ),
            ComposerAttachmentAdmission.projectLane(
                id: "cursor", inputs: nil, available: false, poolMode: .explicit
            ),
        ].compactMap { $0 }

        let result = ComposerAttachmentAdmission.resolve(
            poolMode: .explicit,
            attachments: [attachment],
            lanes: lanes
        )

        #expect(lanes.map(\.id) == ["claude", "cursor"])
        #expect(result.outcome == .refused)
        #expect(result.rejected.map(\.laneID) == ["cursor"])
    }

    @Test func autoPoolProjectsOnlyAvailableAttachmentLanes() {
        let lanes = [
            ComposerAttachmentAdmission.projectLane(
                id: "claude", inputs: [textInput], available: true, poolMode: .auto
            ),
            ComposerAttachmentAdmission.projectLane(
                id: "cursor", inputs: [textInput], available: false, poolMode: .auto
            ),
        ].compactMap { $0 }

        #expect(lanes.map(\.id) == ["claude"])
    }

    @Test func autoMixedPoolDegradesAndDeduplicatesIdentity() {
        let result = ComposerAttachmentAdmission.resolve(
            poolMode: .auto,
            attachments: [attachment],
            lanes: [
                .init(id: "claude", inputs: [textInput]),
                .init(id: "cursor", inputs: []),
                .init(id: "claude", inputs: [textInput]),
            ]
        )
        #expect(result.outcome == .degraded)
        #expect(result.admittedLaneIDs == ["claude"])
        #expect(result.rejected.map(\.laneID) == ["cursor"])
    }

    @Test func attachmentsWithNoCandidateLanesAreRefused() {
        let result = ComposerAttachmentAdmission.resolve(
            poolMode: .auto,
            attachments: [attachment],
            lanes: []
        )
        #expect(result.outcome == .refused)
        #expect(result.admittedLaneIDs.isEmpty)
    }

    @Test func finiteSizeAndCountAreTypedRefusals() {
        let oversized = ComposerAttachmentDescriptor(
            id: "big", kind: "file", mime: "text/plain", name: "big.txt", sizeBytes: 21
        )
        let sizeResult = ComposerAttachmentAdmission.resolveLane(
            lane: .init(id: "claude", inputs: [textInput]), attachments: [oversized]
        )
        #expect(sizeResult.reason == .maxBytesExceeded)

        let countResult = ComposerAttachmentAdmission.resolveLane(
            lane: .init(id: "claude", inputs: [textInput]),
            attachments: [attachment, .init(
                id: "a2", kind: "file", mime: "text/plain", name: "two.txt", sizeBytes: 1
            )]
        )
        #expect(countResult.reason == .maxCountExceeded)
    }
}
