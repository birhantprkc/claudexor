import Foundation
import ClaudexorKit

extension AppModel {
    /// Load run detail from the daemon that owns the execution location.
    ///
    /// Local detail hydration stays on the mainline request owner in
    /// `AppModel+RunDetailLoading`; remote rows are kept in their location-scoped
    /// collection so identical daemon run ids can never collide.
    func loadRunDetail(_ id: String, locationID: ExecutionLocationID) async {
        if locationID == .local {
            await loadRunDetail(id)
            return
        }
        await performRemoteRunDetailLoad(id, locationID: locationID)
    }

    private func performRemoteRunDetailLoad(
        _ id: String,
        locationID: ExecutionLocationID
    ) async {
        guard let requestClient = gateway(for: locationID),
              let original = remoteTasks[locationID]?.first(where: {
                  $0.id == id || $0.resolvedRunId == id
              })
        else { return }
        do {
            let detail = try await requestClient.runDetail(runId: id)
            guard selectedExecutionLocation == locationID,
                  gateway(for: locationID) === requestClient,
                  let index = remoteTasks[locationID]?.firstIndex(where: {
                      $0.id == id || $0.resolvedRunId == id
                  })
            else { return }
            var task = Self.liveTask(from: detail.summary)
            task.diff = original.diff
            task.operatorDecisionAction = detail.operatorDecisionAction
            task.outcomeBanner = detail.outcomeBanner
            task.applyEligibility = detail.applyEligibility
            task.planReadiness = detail.planReadiness
            task.planQuestions = detail.planQuestions
            task.council = detail.council
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser =
                detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            task.artifactPaths = detail.artifacts.map(\.path)
            if let planItems = RunDetailMapping.planItems(detail.planProgress) {
                task.plan = planItems
            }
            task.candidates = RunDetailMapping.candidates(
                detail.candidates, runPhase: task.phase)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
                task.valuationUsd = budget.knownValuationUsd
            }
            if !detail.timeline.isEmpty {
                task.activity = detail.timeline.map(Self.activityEvent(from:))
            }
            if let primary = detail.primaryOutput,
               let text = primary.text,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               primary.kind != "patch"
            {
                let rendered = primary.truncated == true
                    ? text
                        + "\n\n_Inline preview bounded; open \(primary.path) for the full output._"
                    : text
                if primary.kind == "diagnostic" || detail.summary.outputReadyState == "diagnostic" {
                    task.diagnosticText = rendered
                    task.answerText = nil
                } else {
                    task.answerText = rendered
                }
            }
            let failure = detail.failure ?? detail.summary.failure
            let findings = detail.reviewFindings.compactMap {
                Self.finding(from: $0, taskTitle: task.title)
            }
            if !findings.isEmpty { task.findings = findings }
            task.reviewVerdict = RunDetailMapping.reviewVerdict(
                decision: detail.decision,
                candidates: detail.candidates,
                findings: task.findings,
                failure: failure,
                phase: task.phase,
                outcomeFacts: task.outcomeFacts)
            task.diagnosticText = RunDiagnosticsPresentation.summary(
                detail: detail, error: task.engineError)
            remoteTasks[locationID]?[index] = task
        } catch {
            guard gateway(for: locationID) === requestClient,
                  let index = remoteTasks[locationID]?.firstIndex(where: {
                      $0.id == id || $0.resolvedRunId == id
                  })
            else { return }
            remoteTasks[locationID]?[index].engineError =
                "Could not load run detail: \(error)"
            remoteTasks[locationID]?[index].diagnosticText =
                remoteTasks[locationID]?[index].engineError
        }
    }
}
