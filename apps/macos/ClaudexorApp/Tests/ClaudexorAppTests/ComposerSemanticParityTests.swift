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
            var kind: String
            var mimeTypes: [String]
            var maxBytes: Int
            var maxCount: Int
            var transport: String
        }

        struct Attachment: Decodable {
            var id: String
            var kind: String
            var mime: String
            var name: String
            var sizeBytes: Int
        }

        struct AttachmentCase: Decodable {
            var name: String
            var attachments: [Attachment]
            var admitted: Bool
            var reason: String
        }

        var runControls: [RunControl]
        var attachmentInput: AttachmentInput
        var attachmentCases: [AttachmentCase]
    }

    @Test func projectionsMatchTheSharedSemanticFixture() throws {
        let fixtureURL = try #require(
            Bundle.module.url(
                forResource: "composer-semantic-parity",
                withExtension: "json"
            )
        )
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))

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

        let input = HarnessAttachmentInput(
            kind: fixture.attachmentInput.kind,
            mimeTypes: fixture.attachmentInput.mimeTypes,
            maxBytes: fixture.attachmentInput.maxBytes,
            maxCount: fixture.attachmentInput.maxCount,
            transport: fixture.attachmentInput.transport
        )
        for testCase in fixture.attachmentCases {
            let attachments = testCase.attachments.map {
                ComposerAttachmentDescriptor(
                    id: $0.id,
                    kind: $0.kind,
                    mime: $0.mime,
                    name: $0.name,
                    sizeBytes: $0.sizeBytes
                )
            }
            let actual = ComposerAttachmentAdmission.resolveLane(
                lane: .init(id: "fixture", inputs: [input]),
                attachments: attachments
            )
            #expect(actual.admitted == testCase.admitted, Comment(rawValue: testCase.name))
            #expect(actual.reason.rawValue == testCase.reason, Comment(rawValue: testCase.name))
        }
    }
}
