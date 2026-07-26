import Foundation

extension TaskRun {
    /// The review gate needs an operator decision: blocking findings remain and
    /// no decision has been recorded yet. Derived from the honest outcome axes.
    var reviewNeedsDecision: Bool {
        guard phase.isTerminal else { return false }
        let blocked = outcomeFacts?.review == "blocked" || reviewVerdict == .findings
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
