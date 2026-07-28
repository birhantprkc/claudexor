import ClaudexorKit
import Testing
@testable import ClaudexorApp

@Suite struct ComposerAttachmentManifestTests {
    @Test func finiteManifestDeclarationsProjectWithoutBooleanCapabilityLoss() {
        let manifest = JSONValue.object([
            "capability_profile": .object([
                "attachment_inputs": .array([
                    .object([
                        "kind": .string("image"),
                        "mime_types": .array([.string("image/png"), .string("image/jpeg")]),
                        "max_bytes": .number(1_048_576),
                        "max_count": .number(2),
                        "transport": .string("file_path"),
                    ]),
                    .object([
                        "kind": .string("file"),
                        "mime_types": .array([.string("text/plain")]),
                        "max_bytes": .number(4_096),
                        "max_count": .number(4),
                        "transport": .string("text_inline"),
                    ]),
                ]),
            ]),
        ])

        let inputs = AppModel.attachmentInputs(manifest: manifest)
        #expect(inputs == [
            HarnessAttachmentInput(
                kind: "image",
                mimeTypes: ["image/png", "image/jpeg"],
                maxBytes: 1_048_576,
                maxCount: 2,
                transport: "file_path"
            ),
            HarnessAttachmentInput(
                kind: "file",
                mimeTypes: ["text/plain"],
                maxBytes: 4_096,
                maxCount: 4,
                transport: "text_inline"
            ),
        ])
    }

    @Test func malformedOrNonFiniteDeclarationsFailClosed() {
        let manifest = JSONValue.object([
            "capability_profile": .object([
                "attachment_inputs": .array([
                    .object([
                        "kind": .string("image"),
                        "mime_types": .array([.string("image/png")]),
                        "max_bytes": .number(12.5),
                        "max_count": .number(1),
                        "transport": .string("file_path"),
                    ]),
                    .object([
                        "kind": .string("audio"),
                        "mime_types": .array([.string("audio/mpeg")]),
                        "max_bytes": .number(100),
                        "max_count": .number(1),
                        "transport": .string("file_path"),
                    ]),
                ]),
            ]),
        ])

        #expect(AppModel.attachmentInputs(manifest: manifest).isEmpty)
    }
}
