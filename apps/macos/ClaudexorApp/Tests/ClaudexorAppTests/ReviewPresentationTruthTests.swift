import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ReviewPresentationTruthTests {
    private func finding() -> Finding {
        Finding(
            id: "advisory-1",
            severity: .minor,
            category: "maintainability",
            title: "Advisory",
            detail: "Non-blocking review evidence",
            reviewer: .codex,
            routeProof: .verified,
            evidenceFile: nil,
            evidenceLine: nil
        )
    }

    private func reviewFailure() throws -> RunFailureInfo {
        try JSONDecoder().decode(
            RunFailureInfo.self,
            from: Data(#"{"phase":"review","safeMessage":"Review failed"}"#.utf8))
    }

    private func facts(
        _ review: String,
        lifecycle: String = "succeeded",
        checks: String = "not_configured",
        reason: String? = nil
    ) -> RunOutcomeFacts {
        RunOutcomeFacts(
            lifecycle: lifecycle,
            noChanges: false,
            checks: checks,
            review: review,
            reason: reason
        )
    }

    private func run(
        outcomeFacts: RunOutcomeFacts?, verdict: ReviewVerdict,
        phase: RunPhase = .succeeded
    ) -> TaskRun {
        var run = TaskRun(
            id: "run-1", title: "Run", prompt: "", mode: .agent, phase: phase,
            project: "repo", harnesses: [.cursor], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .verified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [finding()], diff: []
        )
        run.outcomeFacts = outcomeFacts
        run.reviewVerdict = verdict
        run.applyState = "applied"
        run.adopted = true
        return run
    }

    @Test func approvedTerminalFactsOutrankAdvisoryFindings() {
        let verdict = RunDetailMapping.reviewVerdict(
            decision: nil,
            candidates: [],
            findings: [finding()],
            failure: nil,
            phase: .succeeded,
            outcomeFacts: facts("approved")
        )

        #expect(verdict == .clean)
        let stale = run(outcomeFacts: facts("approved"), verdict: .findings)
        #expect(stale.effectiveReviewVerdict == .clean)
        #expect(!stale.reviewNeedsDecision)
    }

    @Test func blockedTerminalFactsStillRequireADecision() {
        let verdict = RunDetailMapping.reviewVerdict(
            decision: nil,
            candidates: [],
            findings: [],
            failure: nil,
            phase: .succeeded,
            outcomeFacts: facts("blocked")
        )

        #expect(verdict == .findings)
        let blocked = run(outcomeFacts: facts("blocked"), verdict: .clean)
        #expect(blocked.effectiveReviewVerdict == .findings)
        #expect(blocked.reviewNeedsDecision)
    }

    @Test func failedChecksKeepTheServerAuthorizedDecisionPath() {
        let checksFailed = run(
            outcomeFacts: facts("approved", checks: "failed", reason: "checks_failed"),
            verdict: .clean)

        #expect(checksFailed.effectiveReviewVerdict == .clean)
        #expect(checksFailed.reviewNeedsDecision)
        #expect(DecisionApplyPresentation.isDecisionFlow(checksFailed))
        #expect(DecisionApplyPresentation.showsDecisionBar(checksFailed, riskAccepted: false))
    }

    @Test func failedLifecycleCannotManufactureARiskDecision() {
        let failed = run(
            outcomeFacts: facts("blocked", lifecycle: "failed"),
            verdict: .findings,
            phase: .failed)

        #expect(!failed.reviewNeedsDecision)
    }

    @Test func terminalNotRunOutranksStaleFindingProgress() {
        let notRun = run(outcomeFacts: facts("not_run"), verdict: .findings)

        #expect(notRun.effectiveReviewVerdict == .notRun)
        #expect(!notRun.reviewNeedsDecision)
    }

    @Test func terminalReviewFailureOutranksAggregatedOldFindings() throws {
        let verdict = RunDetailMapping.reviewVerdict(
            decision: nil,
            candidates: [],
            findings: [finding()],
            failure: try reviewFailure(),
            phase: .failed,
            outcomeFacts: facts("not_run", lifecycle: "failed")
        )

        #expect(verdict == .error)
    }

    @Test func legacyRunWithoutTerminalFactsKeepsFindingsFallback() {
        let verdict = RunDetailMapping.reviewVerdict(
            decision: nil,
            candidates: [],
            findings: [finding()],
            failure: nil,
            phase: .succeeded,
            outcomeFacts: nil
        )

        #expect(verdict == .findings)
        #expect(run(outcomeFacts: nil, verdict: verdict).reviewNeedsDecision)
    }
}
