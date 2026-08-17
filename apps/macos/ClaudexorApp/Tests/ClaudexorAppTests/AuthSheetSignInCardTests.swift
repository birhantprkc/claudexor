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

    /// The automatic replacement is BOUNDED. Uncapped, a user who stepped away
    /// collected a fresh detached vendor login every 60 s, each one silently
    /// invalidating the code the previous link was still showing.
    @Test func automaticLinkReplacementIsBoundedAndUserPressesReArmIt() {
        var budget = AuthSheetPresentation.ReissueBudget()
        #expect(budget.armed)

        // Unattended replacements spend the budget and do not renew it.
        for _ in 0..<AuthSheetPresentation.ReissueBudget.automaticLimit {
            budget.spend(automatic: true)
        }
        #expect(!budget.armed)
        budget.spend(automatic: true)
        #expect(!budget.armed)

        // A user pressing "Get a new link" proves someone is watching.
        budget.spend(automatic: false)
        #expect(budget.armed)
    }

    /// The lapsed copy must not promise a replacement link in the branch that
    /// is not issuing one — reachable both when the card mounts on an already
    /// expired job and when the automatic budget above is spent.
    @Test func lapsedCopyPromisesAFreshLinkOnlyWhenOneIsComing() {
        let replacing = AuthSheetPresentation.lapsedWindowMessage(replacing: true)
        let dead = AuthSheetPresentation.lapsedWindowMessage(replacing: false)
        #expect(replacing != dead)
        for message in [replacing, dead] {
            #expect(message.contains("cannot be extended"))
            #expect(message.contains("dead"))
        }
        #expect(replacing.localizedCaseInsensitiveContains("issuing a fresh one"))
        #expect(!dead.localizedCaseInsensitiveContains("issuing"))
        #expect(dead.localizedCaseInsensitiveContains("get a new link"))
    }

    /// The Log in tooltip promised a Terminal window for every family except
    /// codex. No login this sheet starts opens one: it always uses the `daemon`
    /// transport, and every daemon-hosted mode is hosted in the sheet's own card
    /// (packages/cli/src/setup-jobs.ts). One sentence, no per-family guessing.
    @Test func loginTooltipNeverPromisesATerminalWindow() {
        for family in [HarnessFamily.agy, .claude, .codex, .cursor] {
            let start = AuthSheetPresentation.nativeLoginHelp(family: family, verified: false)
            let manage = AuthSheetPresentation.nativeLoginHelp(family: family, verified: true)
            #expect(start.contains(family.label))
            #expect(manage.contains(family.label))
            #expect(!start.localizedCaseInsensitiveContains("a Terminal window opens"))
            #expect(start.contains("no Terminal window"))
            #expect(start != manage)
        }
        #expect(AuthSheetPresentation.nativeLoginHelp(family: .agy, verified: false)
            .contains("Antigravity"))
    }

    /// Recheck ran `refreshAuthReadinessAfterSetupLifecycle`, which returns
    /// false immediately for a family with no default credential store — so
    /// Antigravity reported "check failed … reconnect the engine" every time,
    /// including right after a successful login. A check that never ran must
    /// not be reported as a failure, nor as a probe that completed.
    @Test func recheckTellsTheTruthForAFamilyWithNoDefaultStore() {
        let agy = AuthSheetPresentation.recheckStatus(
            family: .agy, profileId: nil, job: nil, succeeded: true)
        #expect(agy.contains("Antigravity"))
        #expect(!agy.localizedCaseInsensitiveContains("failed"))
        #expect(agy.localizedCaseInsensitiveContains("no default login store"))
        #expect(agy.localizedCaseInsensitiveContains("accounts were refreshed"))

        // A REAL failure of that accounts refresh still says so, without
        // claiming a source-targeted probe was run.
        let agyFailed = AuthSheetPresentation.recheckStatus(
            family: .agy, profileId: nil, job: nil, succeeded: false)
        #expect(agyFailed.localizedCaseInsensitiveContains("could not refresh"))
        #expect(!agyFailed.contains("Exact auth-readiness check"))

        // Families that DO have a default store keep their existing wording.
        for family in [HarnessFamily.claude, .codex, .cursor] {
            #expect(AuthSheetPresentation.recheckStatus(
                family: family, profileId: nil, job: nil, succeeded: true)
                == "Exact auth-readiness check completed for \(family.label).")
            #expect(AuthSheetPresentation.recheckStatus(
                family: family, profileId: nil, job: nil, succeeded: false)
                == "Exact auth-readiness check failed for \(family.label). Reconnect the engine and try again.")
        }

        // A PROFILE sheet always has an exact store to read, agy included.
        #expect(AuthSheetPresentation.recheckStatus(
            family: .agy, profileId: "work", job: nil, succeeded: true)
            == "Account readiness refreshed for this Antigravity profile.")
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
