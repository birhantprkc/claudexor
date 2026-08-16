import Foundation
import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// The `oauth_url_input` sign-in card's pure rules. The card itself is SwiftUI
/// and has no headless test here, so every decision it makes about the vendor's
/// one-shot window lives in `AuthSheetPresentation` and is pinned below.
@Suite struct AuthSheetSignInCardTests {
    /// The card names the PRODUCT, never the binary. Antigravity ships as `agy`
    /// on disk; a user signing in has no idea what `agy` is.
    @Test func signInCardNamesTheProductNotTheBinary() {
        let card = AuthSheetPresentation.loginDisclosureCard(harness: .agy)
        #expect(card.vendor == "Antigravity")
        #expect(card.vendor != SetupHarness.agy.rawValue)
        // Only codex has a second app-server flow to switch to.
        #expect(!card.offersBrowserCallback)
        // No login card may fall back to showing a raw harness id as the vendor.
        for harness in SetupHarness.allCases {
            let vendor = AuthSheetPresentation.loginDisclosureCard(harness: harness).vendor
            #expect(vendor != harness.rawValue)
            #expect(!vendor.isEmpty)
        }
        #expect(AuthSheetPresentation.loginDisclosureCard(harness: .codex).offersBrowserCallback)
    }

    /// The deadline may only close a window that is still WAITING for a code.
    /// Once a value reached the daemon (or is on its way), the vendor owns the
    /// exchange: lapsing there would re-issue the login, cancel the job, and
    /// burn a one-time code that had already been accepted.
    @Test func deliveredCodeOutranksTheDeadline() {
        #expect(AuthSheetPresentation.deadlineMayLapse(codeDelivered: false, sending: false))
        #expect(!AuthSheetPresentation.deadlineMayLapse(codeDelivered: true, sending: false))
        #expect(!AuthSheetPresentation.deadlineMayLapse(codeDelivered: false, sending: true))
        #expect(!AuthSheetPresentation.deadlineMayLapse(codeDelivered: true, sending: true))
    }

    /// A lapsed link is dead, so every control acting on it explains that one
    /// cause (INV-134) instead of looking clickable, and VoiceOver hears both
    /// the address and its expiry — the label must never REPLACE the URL.
    @Test func lapsedLinkIsNamedDeadEverywhereItIsOffered() {
        #expect(AuthSheetPresentation.lapsedSignInLinkHelp.contains("expired"))
        let url = "https://accounts.google.com/o/oauth2/auth?client_id=x"
        let live = AuthSheetPresentation.signInLinkLabel(url: url, lapsed: false)
        let dead = AuthSheetPresentation.signInLinkLabel(url: url, lapsed: true)
        #expect(live.contains(url))
        #expect(dead.contains(url))
        #expect(live != dead)
        #expect(dead.localizedCaseInsensitiveContains("expired"))
    }

    /// One deadline, one clock. While the paste card is on screen it owns the
    /// countdown (it sits beside the field the deadline governs); the setup-job
    /// panel yields so the same fact is not ticked twice on one sheet.
    @Test func onlyOneSurfaceCountsDownTheSignInWindow() {
        #expect(!AuthSheetPresentation.jobPanelShowsDeadline(
            disclosureFlow: .oauthUrlInput, phase: .awaitingUser))
        // No card on screen (or a flow whose card draws no countdown): the
        // panel is the only owner left and keeps rendering it.
        #expect(AuthSheetPresentation.jobPanelShowsDeadline(
            disclosureFlow: nil, phase: .awaitingUser))
        #expect(AuthSheetPresentation.jobPanelShowsDeadline(
            disclosureFlow: .oauthUrl, phase: .awaitingUser))
        #expect(AuthSheetPresentation.jobPanelShowsDeadline(
            disclosureFlow: .chatgptDeviceCode, phase: .awaitingUser))
        #expect(AuthSheetPresentation.jobPanelShowsDeadline(
            disclosureFlow: .oauthUrlInput, phase: .verifying))
    }

    /// Submit stays off for a lapsed window: retyping cannot reach a vendor
    /// that stopped listening, so the card names the cause and offers a link.
    @Test func lapsedWindowRefusesAnotherPasteAndSaysWhy() {
        let lapsed = AuthSheetPresentation.SignInCodeAvailability(
            windowLapsed: true, sending: false, codeField: "123456")
        #expect(!lapsed.enabled)
        #expect(lapsed.blockedReason == .windowLapsed)
        #expect(lapsed.help.localizedCaseInsensitiveContains("new link"))
    }
}
