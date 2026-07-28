import AppKit
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// The Settings surface of the catalog-fed picker class (issue #53 — same
/// contract as `ComposerModelsSectionLayoutTests` proves for the composer):
/// a vendor catalog with pathological label/id lengths must not widen the
/// closed model-override control past its token width.
@Suite(.serialized)
struct HarnessModelOverrideLayoutTests {
    @MainActor
    @Test func cursorCatalogCannotWidenTheSettingsOverrideField() {
        let longID = String(repeating: "cursor-agent-preview-", count: 6)
        let models = HarnessModelsResponse(
            harnessId: HarnessFamily.cursor.rawValue,
            models: [
                HarnessModel(
                    id: longID,
                    label: "A deliberately long Cursor model label that must stay inside the row"
                ),
            ],
            source: "api"
        )
        let field = HarnessModelOverrideField(
            family: .cursor,
            modelDraft: .constant(""),
            fetch: { _ in nil },
            models: .constant(models)
        )
        let host = NSHostingView(rootView: field)

        host.layoutSubtreeIfNeeded()

        // The fixed 180pt control plus a generous allowance for the
        // `LabeledContent` "Model" label column — an UNBOUNDED catalog string
        // would blow hundreds of points past this.
        #expect(host.fittingSize.width <= Theme.Layout.modelPickerWidth + 120)
    }
}
