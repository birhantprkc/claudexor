import Foundation

extension TaskRun {
    /// The effective review presentation. Terminal facts outrank mutable live
    /// progress; active and legacy runs retain their last evidence projection.
    var effectiveReviewVerdict: ReviewVerdict {
        RunDetailMapping.effectiveReviewVerdict(
            outcomeFacts: outcomeFacts, fallback: reviewVerdict)
    }

    /// A risk-overridable terminal needs an operator decision: review blocked or
    /// checks failed after a succeeded lifecycle, with no decision recorded yet.
    /// This mirrors the server-owned needsDecision predicate exactly.
    var reviewNeedsDecision: Bool {
        guard phase.isTerminal else { return false }
        let blocked = outcomeFacts.map {
            $0.lifecycle == "succeeded"
                && ($0.review == "blocked" || $0.checks == "failed")
        } ?? (effectiveReviewVerdict == .findings)
        return blocked && operatorDecisionAction == nil
    }

    /// Human-readable effective access, including an explicit upgrade receipt.
    var accessLabel: String? {
        guard let effective = effectiveAccess else {
            return requestedAccess.map(AccessProfile.humanize)
        }
        if let requested = requestedAccess, requested != effective {
            return "\(AccessProfile.humanize(requested)) → \(AccessProfile.humanize(effective))"
        }
        return AccessProfile.humanize(effective)
    }

    var planDone: Int { plan.filter { $0.state == .done }.count }
    var filesChanged: Int { diff.count }
    var spendFraction: Double {
        spendKnown && capKnown && capUsd > 0 ? min(spendUsd / capUsd, 1) : 0
    }
    var budgetLabel: String {
        let spend = spendKnown
            ? "\(spendEstimated ? "~" : "")\(String(format: "$%.4f", spendUsd))"
            : "Unknown"
        let cap = budgetUnlimited
            ? "Unlimited"
            : capKnown ? String(format: "$%.2f", capUsd) : "Unknown"
        return "\(spend) / \(cap)"
    }

    /// A terminal status is presented as Finalizing until its final content is
    /// hydrated; this prevents a green result beside an empty Outcome panel.
    var isFinalizing: Bool {
        guard isLive, phase.isTerminal, phase != .cancelled else { return false }
        let diagnosticIsContent = phase != .succeeded || outputReadyState == "diagnostic"
        let hasContent =
            !(answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || hasPatchArtifact
            || (diagnosticIsContent
                && !(diagnosticText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || engineError != nil
        return !hasContent
    }
}
