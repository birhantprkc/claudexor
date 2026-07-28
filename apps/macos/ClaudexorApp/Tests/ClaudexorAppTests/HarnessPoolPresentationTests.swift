import Foundation
import Testing
@testable import ClaudexorApp

/// Owner F9: the harness pool's Auto-vs-subset mode mapping. The wire body must
/// be UNCHANGED in Auto (empty pool = "no explicit pool"); only an explicit
/// subset sends ids. These pin that mapping so the UI can't drift from the wire.
@Suite struct HarnessPoolPresentationTests {
    private let available = ["claude", "codex", "cursor", "opencode"]

    @Test func emptyPoolIsAutoAndIncludesAllAvailable() {
        #expect(HarnessPoolPresentation.isAuto(pool: []))
        for id in available {
            #expect(HarnessPoolPresentation.isIncluded(id, pool: [], available: available))
        }
        #expect(HarnessPoolPresentation.caption(pool: []).hasPrefix("Auto"))
    }

    @Test func selectingAutoSendsEmptyWire() {
        // Auto's wire body is the "no explicit pool" the composer already sends.
        #expect(HarnessPoolPresentation.selectingAuto().isEmpty)
    }

    @Test func firstTapFromAutoMaterializesAllMinusTapped() {
        // Tapping one chip in Auto switches to explicit mode: the visible set was
        // "all available", so the result is all-available minus the tapped one, in
        // canonical order.
        let next = HarnessPoolPresentation.toggling("codex", pool: [], available: available)
        #expect(next == ["claude", "cursor", "opencode"])
        #expect(!HarnessPoolPresentation.isAuto(pool: next))
        #expect(HarnessPoolPresentation.caption(pool: next).hasPrefix("Explicit"))
    }

    @Test func explicitModeTogglesWithinSubsetAndKeepsOrder() {
        let pool = ["claude", "cursor"]
        // Re-add a harness → canonical order, not append order.
        #expect(HarnessPoolPresentation.toggling("codex", pool: pool, available: available)
                == ["claude", "codex", "cursor"])
        // Remove one → the remainder.
        #expect(HarnessPoolPresentation.toggling("claude", pool: pool, available: available)
                == ["cursor"])
    }

    @Test func explicitInclusionReflectsSubsetNotAll() {
        let pool = ["claude"]
        #expect(HarnessPoolPresentation.isIncluded("claude", pool: pool, available: available))
        #expect(!HarnessPoolPresentation.isIncluded("codex", pool: pool, available: available))
    }

    @Test func chipDescriptorKeepsHelpAndAccessibilityValueInSyncWithMembership() {
        let included = HarnessPoolPresentation.chipDescriptor(
            "claude", pool: ["claude"], available: available,
            availability: .init(available: true, reason: "")
        )
        let excluded = HarnessPoolPresentation.chipDescriptor(
            "codex", pool: ["claude"], available: available,
            availability: .init(available: true, reason: "")
        )
        #expect(included.included)
        #expect(included.help.contains("included"))
        #expect(included.accessibilityValue == "Included")
        #expect(!excluded.included)
        #expect(excluded.help.contains("excluded"))
        #expect(excluded.accessibilityValue == "Excluded")
    }

    @Test func unavailableHarnessPreservesExplicitMembershipInEveryPresentationLayer() {
        let unavailable = HarnessPoolPresentation.Availability(
            available: false, reason: "Claude is not installed."
        )
        let included = HarnessPoolPresentation.chipDescriptor(
            "claude", pool: ["claude"], available: available,
            availability: unavailable
        )
        let excluded = HarnessPoolPresentation.chipDescriptor(
            "codex", pool: ["claude"], available: available,
            availability: unavailable
        )
        #expect(included.included)
        #expect(included.help.contains("included"))
        #expect(included.help.contains("not installed"))
        #expect(included.accessibilityValue == "Included, unavailable")
        #expect(!excluded.included)
        #expect(excluded.help.contains("excluded"))
        #expect(excluded.help.contains("not installed"))
        #expect(excluded.accessibilityValue == "Excluded, unavailable")
    }

    @Test func autoDescribesAnUnavailableHarnessWithoutCallingThePoolExplicit() {
        let descriptor = HarnessPoolPresentation.chipDescriptor(
            "claude", pool: [], available: ["codex"],
            availability: .init(available: false, reason: "Claude is not installed.")
        )
        #expect(!descriptor.included)
        #expect(descriptor.help.contains("Auto"))
        #expect(descriptor.help.contains("not installed"))
        #expect(descriptor.accessibilityValue == "Not included by Auto, unavailable")
    }

    @Test func emptyingTheSubsetFallsBackToAuto() {
        // Removing the last explicit harness leaves an empty pool = Auto (the wire
        // treats empty as auto, so the UI must read it the same way).
        let next = HarnessPoolPresentation.toggling("claude", pool: ["claude"], available: available)
        #expect(next.isEmpty)
        #expect(HarnessPoolPresentation.isAuto(pool: next))
    }

    /// QA-011: the included-family set the model rows consume is the SAME set the
    /// chips highlight — Auto expands to all available, an explicit subset stays
    /// itself. This is what makes per-harness model rows appear under Auto instead
    /// of a blank section.
    @Test func includedFamiliesMirrorsTheChipHighlight() {
        // Auto (empty pool): every available harness is an included row.
        #expect(HarnessPoolPresentation.includedFamilies(pool: [], available: available) == available)
        // Explicit subset: exactly the subset, in its order — no Auto expansion.
        let subset = ["claude", "codex"]
        #expect(HarnessPoolPresentation.includedFamilies(pool: subset, available: available) == subset)
        // Every included family is also chip-highlighted (the two never disagree).
        for id in HarnessPoolPresentation.includedFamilies(pool: [], available: available) {
            #expect(HarnessPoolPresentation.isIncluded(id, pool: [], available: available))
        }
    }
}
