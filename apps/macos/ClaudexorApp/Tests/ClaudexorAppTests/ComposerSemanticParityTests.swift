import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ComposerSemanticParityTests {
    private struct Fixture: Decodable {
        struct Control: Decodable {
            var applicable: Bool
            var reason: String?
        }

        struct RunControl: Decodable {
            var name: String
            var schemaMode: String
            var swiftMode: String
            var reviewers: Control
            var protectedPathApprovals: Control
        }

        struct AttachmentInput: Decodable {
            var name: String
            var kind: String
            var mimeTypes: [String]
            var maxBytes: Int
            var maxCount: Int
            var transport: String

            var projected: HarnessAttachmentInput {
                .init(
                    kind: kind,
                    mimeTypes: mimeTypes,
                    maxBytes: maxBytes,
                    maxCount: maxCount,
                    transport: transport
                )
            }
        }

        struct Attachment: Decodable {
            var id: String
            var kind: String
            var mime: String
            var name: String
            var sizeBytes: Int

            var projected: ComposerAttachmentDescriptor {
                .init(id: id, kind: kind, mime: mime, name: name, sizeBytes: sizeBytes)
            }
        }

        struct AttachmentCase: Decodable {
            var name: String
            var inputNames: [String]
            var attachments: [Attachment]
            var admitted: Bool
            var reason: String
        }

        struct PoolLane: Decodable {
            var id: String
            var inputNames: [String]?
            var available: Bool
        }

        struct Rejection: Decodable {
            var laneID: String
            var reason: String
        }

        struct AttachmentPoolCase: Decodable {
            var name: String
            var poolMode: String
            var attachments: [Attachment]
            var lanes: [PoolLane]
            var outcome: String
            var admittedLaneIDs: [String]
            var rejected: [Rejection]
        }

        var generatedBy: [String]
        var runControls: [RunControl]
        var attachmentInputs: [AttachmentInput]
        var attachmentCases: [AttachmentCase]
        var attachmentPoolCases: [AttachmentPoolCase]
    }

    @Test func projectionsMatchTheGeneratedSemanticFixture() throws {
        let fixtureURL = try #require(
            Bundle.module.url(
                forResource: "composer-semantic-parity",
                withExtension: "json"
            )
        )
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        #expect(fixture.generatedBy == ["runControlApplicability", "RequestRequirementsResolver"])

        for testCase in fixture.runControls {
            let mode = try #require(
                RunMode(rawValue: testCase.swiftMode),
                Comment(rawValue: testCase.name)
            )
            let actual = ComposerRunControlApplicability.resolve(mode: mode)
            #expect(actual.reviewers.applicable == testCase.reviewers.applicable, Comment(rawValue: testCase.name))
            #expect(actual.reviewers.reason == testCase.reviewers.reason, Comment(rawValue: testCase.name))
            #expect(
                actual.protectedPathApprovals.applicable == testCase.protectedPathApprovals.applicable,
                Comment(rawValue: testCase.name)
            )
            #expect(
                actual.protectedPathApprovals.reason == testCase.protectedPathApprovals.reason,
                Comment(rawValue: testCase.name)
            )
        }

        let inputByName = Dictionary(
            uniqueKeysWithValues: fixture.attachmentInputs.map { ($0.name, $0.projected) }
        )
        func inputs(_ names: [String]?) throws -> [HarnessAttachmentInput]? {
            guard let names else { return nil }
            return try names.map { name in
                try #require(inputByName[name], Comment(rawValue: name))
            }
        }

        for testCase in fixture.attachmentCases {
            let actual = ComposerAttachmentAdmission.resolveLane(
                lane: .init(id: "fixture", inputs: try inputs(testCase.inputNames) ?? []),
                attachments: testCase.attachments.map(\.projected)
            )
            #expect(actual.admitted == testCase.admitted, Comment(rawValue: testCase.name))
            #expect(actual.reason.rawValue == testCase.reason, Comment(rawValue: testCase.name))
        }

        for testCase in fixture.attachmentPoolCases {
            let poolMode: ComposerAttachmentPoolMode = testCase.poolMode == "explicit"
                ? .explicit : .auto
            let lanes = try testCase.lanes.compactMap { lane in
                ComposerAttachmentAdmission.projectLane(
                    id: lane.id,
                    inputs: try inputs(lane.inputNames),
                    available: lane.available,
                    poolMode: poolMode
                )
            }
            let actual = ComposerAttachmentAdmission.resolve(
                poolMode: poolMode,
                attachments: testCase.attachments.map(\.projected),
                lanes: lanes
            )
            #expect(outcomeName(actual.outcome) == testCase.outcome, Comment(rawValue: testCase.name))
            #expect(actual.admittedLaneIDs == testCase.admittedLaneIDs, Comment(rawValue: testCase.name))
            #expect(
                actual.rejected.map { "\($0.laneID):\($0.reason.rawValue)" }
                    == testCase.rejected.map { "\($0.laneID):\($0.reason)" },
                Comment(rawValue: testCase.name)
            )
        }
    }

    private func outcomeName(_ outcome: ComposerAttachmentOutcome) -> String {
        switch outcome {
        case .admitted: "admitted"
        case .degraded: "degraded"
        case .refused: "refused"
        }
    }
}
