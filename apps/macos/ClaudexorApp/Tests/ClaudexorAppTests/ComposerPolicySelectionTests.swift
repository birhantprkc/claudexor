import Testing
@testable import ClaudexorApp

@Suite struct ComposerPolicySelectionTests {
    @Test func browserDerivesEffectiveValuesWithoutReplacingSelections() {
        let policy = ComposerBrowserPolicy(
            selectedAccess: .workspaceWrite,
            selectedWebPolicy: "off",
            browserArmed: true
        )
        #expect(policy.selectedAccess == .workspaceWrite)
        #expect(policy.selectedWebPolicy == "off")
        #expect(policy.effectiveAccess == .full)
        #expect(policy.effectiveWebPolicy == "auto")

        let disarmed = policy.disarmingBrowser()
        #expect(disarmed.effectiveAccess == .workspaceWrite)
        #expect(disarmed.effectiveWebPolicy == "off")
    }

    @Test func explicitlySelectedFullSurvivesBrowserReversal() {
        let policy = ComposerBrowserPolicy(
            selectedAccess: .full,
            selectedWebPolicy: "live",
            browserArmed: true
        ).disarmingBrowser()
        #expect(policy.effectiveAccess == .full)
        #expect(policy.effectiveWebPolicy == "live")
    }

    @Test func readOnlyIntentDisarmsBrowser() {
        #expect(!ComposerBrowserPolicy.browserArmed(true, afterSelecting: .ask))
        #expect(!ComposerBrowserPolicy.browserArmed(true, afterSelecting: .plan))
        #expect(ComposerBrowserPolicy.browserArmed(true, afterSelecting: .agent))
    }

    @Test func unavailableBrowserRestoresSelectedAccessAndWebBeforeViewStateCatchesUp() {
        let policy = ComposerBrowserPolicy(
            selectedAccess: .workspaceWrite,
            selectedWebPolicy: "off",
            browserArmed: true,
            browserAvailable: false
        )

        #expect(!policy.effectiveBrowserArmed)
        #expect(policy.effectiveAccess == .workspaceWrite)
        #expect(policy.effectiveWebPolicy == "off")
        #expect(!ComposerBrowserPolicy.browserArmed(true, afterAvailability: false))
    }

    @Test func availableBrowserStillProjectsItsRequiredAccessAndWeb() {
        let policy = ComposerBrowserPolicy(
            selectedAccess: .workspaceWrite,
            selectedWebPolicy: "off",
            browserArmed: true,
            browserAvailable: true
        )

        #expect(policy.effectiveBrowserArmed)
        #expect(policy.effectiveAccess == .full)
        #expect(policy.effectiveWebPolicy == "auto")
        #expect(ComposerBrowserPolicy.browserArmed(true, afterAvailability: true))
    }
}
