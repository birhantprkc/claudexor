import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ComposerDraftRestorationTests {
    @Test func firstTurnFailureRestoresEveryTurnOptionInput() {
        let attempted = ComposerDraftSnapshot(
            text: "inspect",
            attachments: [PendingAttachment(kind: "file", mime: "text/plain", name: "a.txt", data: Data("a".utf8))],
            mode: .ask,
            capUsdText: "0.05",
            selectedAccess: .readOnly,
            selectedWebPolicy: "off",
            authRoutePreference: "subscription",
            effortPreference: "high",
            maxAttempts: 7,
            agentStrategy: .untilClean,
            delegate: true,
            councilEnabled: true,
            councilMembers: 4,
            browser: false,
            reviewDraft: ComposerReviewDraft(reviewerText: "codex:high"),
            testCommandText: "pnpm test",
            composerModels: ["codex": "gpt"]
        )
        var current = attempted
        current.text = ""
        current.attachments = []
        #expect(ComposerDraftRecovery.afterFailedSend(attempted: attempted, current: current) == attempted)
    }

    @Test func recoveryDoesNotOverwriteAUserWhoAlreadyTypedAgain() {
        let attempted = ComposerDraftSnapshot(text: "first")
        let current = ComposerDraftSnapshot(text: "second", selectedWebPolicy: "live")
        #expect(ComposerDraftRecovery.afterFailedSend(attempted: attempted, current: current) == current)
    }

    @Test func recoveryPreservesNonTextEditsMadeWhileSendWasAwaiting() {
        let attempted = ComposerDraftSnapshot(
            text: "first", capUsdText: "0.05", selectedWebPolicy: "off",
            composerModels: ["codex": "old"]
        )
        let current = ComposerDraftSnapshot(
            text: "", capUsdText: "0.10", selectedWebPolicy: "live",
            composerModels: ["codex": "new"]
        )
        let recovered = ComposerDraftRecovery.afterFailedSend(
            attempted: attempted, current: current
        )
        #expect(recovered.text == "first")
        #expect(recovered.capUsdText == "0.10")
        #expect(recovered.selectedWebPolicy == "live")
        #expect(recovered.composerModels == ["codex": "new"])
    }

    @Test func exactMaterializedThreadSuppressesSelectionReset() {
        let draft = ComposerSelectionContext(locationID: "local", threadID: nil, repoRoot: "/repo")
        let materialized = ComposerSelectionContext(
            locationID: "local", threadID: "thread-1", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: draft)
        let registered = coordinator.registerMaterializedThread(
            "thread-1", for: token, current: draft
        )
        let transition = coordinator.classifySelection(
            from: draft, to: materialized
        )
        #expect(registered)
        #expect(transition == .internalMaterialization)
        #expect(coordinator.ownsCompletion(token, current: materialized))
    }

    @Test func sameRepoExplicitSelectionIsNeverMistakenForMaterialization() {
        let draft = ComposerSelectionContext(locationID: "local", threadID: nil, repoRoot: "/repo")
        let existing = ComposerSelectionContext(
            locationID: "local", threadID: "existing", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: draft)
        let transition = coordinator.classifySelection(from: draft, to: existing)
        let registered = coordinator.registerMaterializedThread(
            "created-later", for: token, current: existing
        )
        #expect(transition == .explicitSelection)
        #expect(!registered)
        #expect(!coordinator.ownsCompletion(token, current: existing))
    }

    @Test func switchingBetweenUnmaterializedDraftsIsAnExplicitSelection() {
        let original = ComposerSelectionContext(
            locationID: "local", threadID: nil, repoRoot: "/old"
        )
        let switched = ComposerSelectionContext(
            locationID: "local", threadID: nil, repoRoot: "/new"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: original)

        let transition = coordinator.classifySelection(from: original, to: switched)

        #expect(transition == .explicitSelection)
        #expect(!coordinator.ownsCompletion(token, current: switched))
    }

    @Test func lateFailureCannotRestoreIntoAnotherThread() {
        let original = ComposerSelectionContext(
            locationID: "local", threadID: "one", repoRoot: "/repo"
        )
        let switched = ComposerSelectionContext(
            locationID: "local", threadID: "two", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: original)
        let transition = coordinator.classifySelection(from: original, to: switched)
        #expect(transition == .explicitSelection)
        #expect(!coordinator.ownsCompletion(token, current: switched))
    }

    @Test func delayedCreateFailureCannotReplaceTheNewSelectionStatus() async {
        let draft = ComposerSelectionContext(
            locationID: "local", threadID: nil, repoRoot: "/repo"
        )
        let switched = ComposerSelectionContext(
            locationID: "local", threadID: "existing", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: draft)
        var status: String? = "New selection status"
        await Task.yield()
        _ = coordinator.classifySelection(from: draft, to: switched)
        status = ComposerCompletionStatus.resolving(
            current: status,
            completion: "Old create failed",
            ownsCompletion: coordinator.ownsCompletion(token, current: switched)
        )
        #expect(status == "New selection status")
    }

    @Test func delayedSendFailureAndSuccessCannotMutateTheNewSelectionStatus() async {
        let original = ComposerSelectionContext(
            locationID: "local", threadID: "one", repoRoot: "/repo"
        )
        let switched = ComposerSelectionContext(
            locationID: "local", threadID: "two", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let token = coordinator.begin(from: original)
        var status: String? = "New selection status"
        await Task.yield()
        _ = coordinator.classifySelection(from: original, to: switched)
        let ownsCompletion = coordinator.ownsCompletion(token, current: switched)
        status = ComposerCompletionStatus.resolving(
            current: status, completion: "Old send failed",
            ownsCompletion: ownsCompletion
        )
        #expect(status == "New selection status")
        status = ComposerCompletionStatus.resolving(
            current: status, completion: nil,
            ownsCompletion: ownsCompletion
        )
        #expect(status == "New selection status")
    }

    @Test func ownedCreateAndSendCompletionsStillPublishStatus() {
        #expect(ComposerCompletionStatus.resolving(
            current: "Previous", completion: "Create failed", ownsCompletion: true
        ) == "Create failed")
        #expect(ComposerCompletionStatus.resolving(
            current: "Previous", completion: nil, ownsCompletion: true
        ) == nil)
    }

    @Test func existingThreadProjectionRefreshAndNextResendKeepOwnership() {
        let original = ComposerSelectionContext(
            locationID: "local", threadID: "one", repoRoot: "/loading"
        )
        let hydrated = ComposerSelectionContext(
            locationID: "local", threadID: "one", repoRoot: "/repo"
        )
        var coordinator = ComposerSubmissionCoordinator()
        let first = coordinator.begin(from: original)
        let transition = coordinator.classifySelection(from: original, to: hydrated)
        #expect(transition == .sameSelection)
        #expect(coordinator.ownsCompletion(first, current: hydrated))
        coordinator.finish(first)

        let resend = coordinator.begin(from: hydrated)
        #expect(coordinator.ownsCompletion(resend, current: hydrated))
    }

    @Test func successfulSendResetsOnlyOptionsTheUserDidNotEditWhileAwaiting() {
        let attempted = ComposerDraftSnapshot(
            text: "first", capUsdText: "0.05", selectedWebPolicy: "off",
            effortPreference: "high", composerModels: ["codex": "old"]
        )
        let current = ComposerDraftSnapshot(
            text: "next", capUsdText: "0.10", selectedWebPolicy: "live",
            effortPreference: "high", composerModels: ["codex": "new"]
        )
        let defaults = ComposerDraftSnapshot(
            text: current.text, selectedAccess: .readOnly
        )
        let recovered = ComposerDraftRecovery.afterSuccessfulSend(
            attempted: attempted, current: current, defaults: defaults
        )
        #expect(recovered.text == "next")
        #expect(recovered.capUsdText == "0.10")
        #expect(recovered.selectedWebPolicy == "live")
        #expect(recovered.composerModels == ["codex": "new"])
        #expect(recovered.effortPreference == "")
        #expect(recovered.selectedAccess == .readOnly)
    }

    @Test func successfulResetComparesNormalizedWireSemantics() {
        let attempted = ComposerDraftSnapshot(
            text: "first",
            capUsdText: "0.05",
            testCommandText: "npm test",
            composerModels: ["codex": "gpt"]
        )
        let current = ComposerDraftSnapshot(
            text: "",
            capUsdText: "$0.050",
            testCommandText: "npm   test",
            composerModels: ["codex": " gpt "]
        )
        let recovered = ComposerDraftRecovery.afterSuccessfulSend(
            attempted: attempted,
            current: current,
            defaults: ComposerDraftSnapshot(selectedAccess: .readOnly)
        )
        #expect(recovered.capUsdText.isEmpty)
        #expect(recovered.testCommandText.isEmpty)
        #expect(recovered.composerModels.isEmpty)
    }
}
