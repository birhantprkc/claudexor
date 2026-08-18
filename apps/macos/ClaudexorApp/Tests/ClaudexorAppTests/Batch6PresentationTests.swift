import Testing
import Foundation
import ClaudexorKit
@testable import ClaudexorApp

/// Batch-6 item b: the auto-switch toggle targets harnesses with a SECOND account
/// and reports on/off/mixed/unavailable honestly.
@Suite struct AccountsAutoBalanceTests {
    @Test func eligibleRequiresASecondEnabledAccountRow() {
        // Unified account model: every identity is a registry row, so ONE row
        // has nothing to rotate to and two ENABLED rows make the harness
        // eligible. Rotation only draws from the enabled pool: two rows with
        // one disabled leave nothing to switch to, so the toggle stays off.
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("claude", true)]).isEmpty)
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("claude", true), ("claude", true)]) == ["claude"])
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("claude", true), ("claude", false)]).isEmpty)
        // An absent `enabled` fails open (the same rule as everywhere else).
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("claude", nil), ("claude", true)]) == ["claude"])
    }

    @Test func capableHarnessesAreEligibleInCanonicalOrder() {
        let ids = AccountsAutoBalance.eligibleHarnessIds(profiles: [
            ("cursor", true), ("cursor", true), ("codex", true),
            ("claude", true), ("claude", true), ("codex", true),
        ])
        #expect(ids == ["claude", "codex"])
    }

    @Test func agyFollowsTheSameTwoRowRule() {
        #expect(AccountsAutoBalance.eligibleHarnessIds(profiles: [("agy", true)]).isEmpty)
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("agy", true), ("agy", true)]) == ["agy"])
    }

    @Test func nonCapableHarnessProfilesAreIgnored() {
        // Only config_dir_login families in the capable-set are targeted:
        // cursor rotates reactively under the engine's `auto` default, but it
        // has no proactive quota source yet, so the app control has not
        // admitted it — cursor stays engine-driven with no app-side knob.
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("opencode", true), ("opencode", true)]).isEmpty)
        #expect(AccountsAutoBalance.eligibleHarnessIds(
            profiles: [("cursor", true), ("cursor", true)]).isEmpty)
    }

    @Test func stateAggregates() {
        #expect(AccountsAutoBalance.state(actions: []) == .unavailable)
        #expect(AccountsAutoBalance.state(actions: ["rotate", "rotate"]) == .on)
        #expect(AccountsAutoBalance.state(actions: ["auto", "auto"]) == .auto)
        #expect(AccountsAutoBalance.state(actions: ["fail", "ask"]) == .off)
        #expect(AccountsAutoBalance.state(actions: ["rotate", "fail"]) == .mixed)
        // The A6 kind-aware default is its own aggregate state, distinct from
        // both On and Off; disagreement with either is mixed.
        #expect(AccountsAutoBalance.state(actions: ["auto", "rotate"]) == .mixed)
        #expect(AccountsAutoBalance.state(actions: ["auto", "fail"]) == .mixed)
    }

    @Test func patchValueTable() {
        // On/Auto set their exact value everywhere (including over a
        // hand-configured ask — an explicit pick of a mode).
        #expect(AccountsAutoBalance.patchValue(current: "auto", choice: .rotate) == "rotate")
        #expect(AccountsAutoBalance.patchValue(current: "fail", choice: .rotate) == "rotate")
        #expect(AccountsAutoBalance.patchValue(current: "ask", choice: .rotate) == "rotate")
        #expect(AccountsAutoBalance.patchValue(current: "rotate", choice: .rotate) == nil)
        #expect(AccountsAutoBalance.patchValue(current: "rotate", choice: .auto) == "auto")
        #expect(AccountsAutoBalance.patchValue(current: "auto", choice: .auto) == nil)
        // Off downgrades rotation (explicit rotate AND the kind-aware auto,
        // which would rotate subscription subjects) but never erases ask.
        #expect(AccountsAutoBalance.patchValue(current: "rotate", choice: .fail) == "fail")
        #expect(AccountsAutoBalance.patchValue(current: "auto", choice: .fail) == "fail")
        #expect(AccountsAutoBalance.patchValue(current: "ask", choice: .fail) == nil)
        #expect(AccountsAutoBalance.patchValue(current: "fail", choice: .fail) == nil)
    }
}

/// D42 item 4: the sidebar row status precedence (running outranks needs-decision).
@Suite struct ThreadRowStatusTests {
    @Test func runningWins() {
        #expect(ThreadRowStatus.of(running: true, needsHuman: true) == .running)
        #expect(ThreadRowStatus.of(running: true, needsHuman: false) == .running)
    }

    @Test func needsDecisionWhenNotRunning() {
        #expect(ThreadRowStatus.of(running: false, needsHuman: true) == .needsDecision)
    }

    @Test func idleOtherwise() {
        #expect(ThreadRowStatus.of(running: false, needsHuman: false) == .idle)
    }

    @Test func remoteSyncTimeUsesTheEnglishProductLocale() {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let expected = date.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened)
                .locale(Locale(identifier: "en_US_POSIX")))

        #expect(formattedRemoteSyncTime(date) == expected)
    }
}

/// D42: the thread's runs are aggregated in conversation order, de-duplicated.
@Suite @MainActor struct ThreadWorkspaceRunIdsTests {
    private func turn(_ id: String, run: String?, card: TurnRunCard? = nil) -> ThreadTurnInfo {
        ThreadTurnInfo(id: id, threadId: "t", runId: run, parentRunId: nil, planRunId: nil,
                       kind: nil, prompt: "", run: card, createdAt: "2026-07-20T00:00:00Z")
    }

    @Test func orderedAndDeduped() {
        let detail = ThreadDetailResponse(
            thread: sampleThread(),
            sessions: [],
            turns: [turn("a", run: "r1"), turn("b", run: nil), turn("c", run: "r2"), turn("d", run: "r1")])
        #expect(ThreadWorkspacePanel.threadRunIds(detail) == ["r1", "r2"])
    }

    @Test func emptyWhenNoRuns() {
        let detail = ThreadDetailResponse(thread: sampleThread(), sessions: [], turns: [turn("a", run: nil)])
        #expect(ThreadWorkspacePanel.threadRunIds(detail).isEmpty)
    }

    @Test func projectedDelegateChildrenFollowParentAndDedupe() throws {
        let card = try JSONDecoder().decode(
            TurnRunCard.self,
            from: Data(#"{"state":"succeeded","delegatedChildRunIds":["c1","c2","c1"]}"#.utf8))
        let detail = ThreadDetailResponse(
            thread: sampleThread(), sessions: [],
            turns: [turn("a", run: "p", card: card), turn("b", run: "c2")])
        #expect(ThreadWorkspacePanel.threadRunIds(detail) == ["p", "c1", "c2"])
    }

    private func sampleThread() -> ThreadSummary {
        // ThreadSummary's memberwise init is internal to the Kit; decode the wire
        // shape instead (also exercises the DTO decode).
        let json = #"""
        {"id":"t","title":"T","repoRoot":"/x","workspaceMode":"in_place","runIds":["r1","r2"],
         "headRunId":"r2","needsHuman":false,"createdAt":"2026-07-20T00:00:00Z","updatedAt":"2026-07-20T00:00:00Z"}
        """#
        return try! JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
    }
}
