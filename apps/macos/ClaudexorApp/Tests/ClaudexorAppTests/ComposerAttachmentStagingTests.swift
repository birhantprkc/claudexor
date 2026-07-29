import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ComposerAttachmentStagingTests {
    private let textLane = ComposerAttachmentLane(
        id: "claude",
        inputs: [HarnessAttachmentInput(
            kind: "file",
            mimeTypes: ["text/plain"],
            maxBytes: 20,
            maxCount: 2,
            transport: "text_inline"
        )]
    )

    @Test func oversizedMetadataSkipsTheByteLoader() {
        var loadCount = 0
        let result = ComposerAttachmentStager.stage(
            sources: [.init(
                url: URL(fileURLWithPath: "/tmp/large.txt"),
                name: "large.txt",
                kind: "file",
                mime: "text/plain"
            )],
            existing: [],
            poolMode: .explicit,
            lanes: [textLane],
            metadata: { _ in .init(sizeBytes: 21) },
            load: { _, _ in
                loadCount += 1
                return Data()
            }
        )

        #expect(loadCount == 0)
        #expect(result.attachments.isEmpty)
        #expect(result.notice?.contains("limits text/plain to 20 bytes") == true)
    }

    @Test func incompatibleMetadataSkipsTheByteLoader() {
        var loadCount = 0
        let result = ComposerAttachmentStager.stage(
            sources: [.init(
                url: URL(fileURLWithPath: "/tmp/image.png"),
                name: "image.png",
                kind: "image",
                mime: "image/png"
            )],
            existing: [],
            poolMode: .explicit,
            lanes: [textLane],
            metadata: { _ in .init(sizeBytes: 5) },
            load: { _, _ in
                loadCount += 1
                return Data()
            }
        )

        #expect(loadCount == 0)
        #expect(result.attachments.isEmpty)
        #expect(result.notice?.contains("does not accept image image/png") == true)
    }

    @Test func selectedMetadataAccumulatesBeforeTheNextRead() {
        var loadCount = 0
        let oneFileLane = ComposerAttachmentLane(
            id: "claude",
            inputs: [HarnessAttachmentInput(
                kind: "file",
                mimeTypes: ["text/plain"],
                maxBytes: 20,
                maxCount: 1,
                transport: "text_inline"
            )]
        )
        let sources = ["one.txt", "two.txt"].map { name in
            ComposerAttachmentSource(
                url: URL(fileURLWithPath: "/tmp/\(name)"),
                name: name,
                kind: "file",
                mime: "text/plain"
            )
        }
        let result = ComposerAttachmentStager.stage(
            sources: sources,
            existing: [],
            poolMode: .explicit,
            lanes: [oneFileLane],
            metadata: { _ in .init(sizeBytes: 1) },
            load: { _, _ in
                loadCount += 1
                return Data([0x61])
            }
        )

        #expect(loadCount == 1)
        #expect(result.attachments.map(\.name) == ["one.txt"])
        #expect(result.notice?.contains("at most 1 matching attachment") == true)
    }

    @Test func admittedRegularFileUsesTheBoundedProductionRead() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-staging-\(UUID().uuidString).txt")
        let bytes = Data("normal file".utf8)
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let result = ComposerAttachmentStager.stage(
            sources: [.pickedFile(url)],
            existing: [],
            poolMode: .explicit,
            lanes: [textLane]
        )

        #expect(result.notices.isEmpty)
        #expect(result.attachments.count == 1)
        #expect(result.attachments.first?.data == bytes)
        #expect(result.attachments.first?.name == url.lastPathComponent)
    }

    @Test func sizeChangeDuringReadIsSkipped() {
        var metadataCall = 0
        let result = ComposerAttachmentStager.stage(
            sources: [.init(
                url: URL(fileURLWithPath: "/tmp/changing.txt"),
                name: "changing.txt",
                kind: "file",
                mime: "text/plain"
            )],
            existing: [],
            poolMode: .explicit,
            lanes: [textLane],
            metadata: { _ in
                metadataCall += 1
                return .init(sizeBytes: metadataCall == 1 ? 12 : 13)
            },
            load: { _, expectedSize in Data(repeating: 0x61, count: expectedSize) }
        )

        #expect(result.attachments.isEmpty)
        #expect(result.notice?.contains("changed size") == true)
    }

    @Test func delayedFileCompletionCannotPublishAfterSelectionSwitch() async {
        let a = ComposerSelectionContext(locationID: "local", threadID: "A", repoRoot: "/repo")
        let b = ComposerSelectionContext(locationID: "local", threadID: "B", repoRoot: "/repo")
        var coordinator = ComposerAttachmentOperationCoordinator()
        let lease = coordinator.begin(from: a)

        await Task.yield()
        coordinator.invalidateSelection()

        #expect(coordinator.owned("file completion", for: lease, current: b) == nil)
    }

    @Test func delayedCaptureCompletionCannotPublishAfterABASwitch() async {
        let a = ComposerSelectionContext(locationID: "local", threadID: "A", repoRoot: "/repo")
        var coordinator = ComposerAttachmentOperationCoordinator()
        let lease = coordinator.begin(from: a)

        await Task.yield()
        coordinator.invalidateSelection() // A -> B
        coordinator.invalidateSelection() // B -> A

        #expect(coordinator.owned("capture completion", for: lease, current: a) == nil)
    }

    @Test func parallelOperationsInOneGenerationRemainOwned() {
        let context = ComposerSelectionContext(
            locationID: "local", threadID: "A", repoRoot: "/repo"
        )
        var coordinator = ComposerAttachmentOperationCoordinator()
        let picker = coordinator.begin(from: context)
        let capture = coordinator.begin(from: context)

        #expect(coordinator.owns(picker, current: context))
        #expect(coordinator.owns(capture, current: context))
    }

    @Test func stagingOwnershipBlocksUntilFinishedAndCancellationRetiresEveryCompletion() {
        let context = ComposerSelectionContext(
            locationID: "local", threadID: "A", repoRoot: "/repo"
        )
        var coordinator = ComposerAttachmentOperationCoordinator()
        let picker = coordinator.begin(from: context)
        let capture = coordinator.begin(from: context)
        #expect(coordinator.inFlightCount == 2)

        coordinator.finish(picker)
        #expect(coordinator.inFlightCount == 1)
        #expect(coordinator.owns(capture, current: context))

        coordinator.cancelAll()
        #expect(coordinator.inFlightCount == 0)
        #expect(!coordinator.owns(capture, current: context))
    }

    @Test func parallelCompletionRevalidatesAgainstTheLiveCount() {
        let oneFileLane = ComposerAttachmentLane(
            id: "claude",
            inputs: [HarnessAttachmentInput(
                kind: "file",
                mimeTypes: ["text/plain"],
                maxBytes: 20,
                maxCount: 1,
                transport: "text_inline"
            )]
        )
        let staged = ComposerAttachmentStagingResult(attachments: [PendingAttachment(
            kind: "file",
            mime: "text/plain",
            name: "second.txt",
            data: Data([0x62])
        )])
        let publication = ComposerAttachmentStager.revalidated(
            staged,
            existing: [ComposerAttachmentDescriptor(
                id: "first",
                kind: "file",
                mime: "text/plain",
                name: "first.txt",
                sizeBytes: 1
            )],
            poolMode: .explicit,
            lanes: [oneFileLane]
        )

        #expect(publication.attachments.isEmpty)
        #expect(publication.notice?.contains("at most 1 matching attachment") == true)
    }

    @Test func explicitSelectionDropsPrivateAttachmentsButMaterializationRetainsThem() {
        let attachment = PendingAttachment(
            kind: "file",
            mime: "text/plain",
            name: "private.txt",
            data: Data("private context".utf8)
        )

        #expect(ComposerAttachmentSelectionPolicy.retained(
            [attachment], after: .explicitSelection
        ).isEmpty)
        #expect(ComposerAttachmentSelectionPolicy.retained(
            [attachment], after: .internalMaterialization
        ) == [attachment])
    }
}
