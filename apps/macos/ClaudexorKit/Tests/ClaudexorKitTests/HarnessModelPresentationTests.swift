import Testing
@testable import ClaudexorKit

/// The OPEN-menu guarantee for catalog-fed model pickers (issue #53): an
/// NSMenu sizes to its widest item, so the menu STRING cap — not any view
/// frame — is what bounds the open dropdown. Both surfaces (composer models
/// rows, Settings model override) render their items through this one
/// derivation.
@Suite struct HarnessModelPresentationTests {
    @Test func longVendorLabelAndIdCapWithMiddleEllipsis() {
        // Real failure shape: a free-text Cursor label plus a 126-char id.
        let id = String(repeating: "cursor-agent-preview-", count: 6)
        let label = "A deliberately long Cursor model label that must stay inside the menu"
        let title = HarnessModelPresentation.menuTitle(label: label, id: id)
        #expect(title.count == HarnessModelPresentation.menuTitleMaxCharacters)
        // The ellipsis sits in the MIDDLE: the human prefix and the
        // differentiating id tail both survive verbatim.
        #expect(title == "A deliberately long Curs…-cursor-agent-preview-)")
    }

    @Test func shortInputsPassThroughUnchanged() {
        #expect(HarnessModelPresentation.menuTitle(label: nil, id: "claude-opus-5") == "claude-opus-5")
        // An EMPTY label degrades to the id, never to "" or " (id)".
        #expect(HarnessModelPresentation.menuTitle(label: "", id: "gpt-5.6-sol") == "gpt-5.6-sol")
        // label == id renders once, not "id (id)".
        #expect(HarnessModelPresentation.menuTitle(label: "gpt-5.6-sol", id: "gpt-5.6-sol") == "gpt-5.6-sol")
        #expect(HarnessModelPresentation.menuTitle(label: "GPT 5.6 Sol", id: "gpt-5.6-sol") == "GPT 5.6 Sol (gpt-5.6-sol)")
        #expect(HarnessModelPresentation.menuTitle(label: nil, id: "") == "")
    }

    @Test func whitespaceRunsCollapseToSingleSpaces() {
        // A menu item must never carry a newline or tab run (§1 rule 4).
        let title = HarnessModelPresentation.menuTitle(label: "Cursor\n Composer\t\tPreview", id: "cmp-1")
        #expect(title == "Cursor Composer Preview (cmp-1)")
    }

    @Test func capBoundaryIsExact() {
        let fits = String(repeating: "a", count: HarnessModelPresentation.menuTitleMaxCharacters)
        #expect(HarnessModelPresentation.menuTitle(label: nil, id: fits) == fits)
        let over = String(repeating: "a", count: HarnessModelPresentation.menuTitleMaxCharacters + 1)
        let capped = HarnessModelPresentation.menuTitle(label: nil, id: over)
        #expect(capped == String(repeating: "a", count: 24) + "…" + String(repeating: "a", count: 23))
    }
}
