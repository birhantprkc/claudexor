import AppKit
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct ComposerModelsSectionLayoutTests {
    @MainActor
    @Test func cursorCatalogCannotWidenThePickerPastTheOptionsPopover() {
        let cursor = HarnessFamily.cursor
        let key = ComposerModelsSection.catalogKey(cursor, route: nil)
        let longID = String(repeating: "cursor-agent-preview-", count: 6)
        let catalog = HarnessModelsResponse(
            harnessId: cursor.rawValue,
            models: [
                HarnessModel(
                    id: longID,
                    label: "A deliberately long Cursor model label that must stay inside the popover"
                ),
            ],
            source: "api"
        )
        let section = ComposerModelsSection(
            families: [cursor],
            primary: cursor,
            selections: .constant([cursor.rawValue: longID]),
            catalogs: .constant([key: catalog]),
            fetch: { _ in nil }
        )
        let host = NSHostingView(rootView: section)

        host.layoutSubtreeIfNeeded()

        let availableWidth = Theme.Layout.composerOptionsWidth - (2 * Theme.Spacing.lg)
        #expect(host.fittingSize.width <= availableWidth)
    }
}
