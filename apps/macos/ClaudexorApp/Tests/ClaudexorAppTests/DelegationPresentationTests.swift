import Testing
import ClaudexorKit
import Foundation
@testable import ClaudexorApp

@MainActor @Suite struct DelegationPresentationTests {
    private func task(_ json: String) throws -> TaskRun {
        AppModel.liveTask(from: try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8)))
    }

    @Test func ineffectiveRequestedDelegateIsADurableWarning() throws {
        let facts = RunDelegationInfo(
            requested: true,
            effective: false,
            used: false,
            reason: "runtime_unavailable",
            remediation: "Repair this exact packaged runtime, then reconnect."
        )
        let warning = try #require(DelegationPresentation.warning(facts, phase: .succeeded))
        #expect(warning.title == "Done with warnings · continued without Delegate")
        #expect(warning.detail == "Repair this exact packaged runtime, then reconnect.")
    }

    @Test func controlFailsClosedForLegacyAndUsesEngineRemediation() {
        let legacy = DelegationPresentation.control(capability: nil, hasFullAccess: true)
        #expect(!legacy.available)
        #expect(legacy.explanation.contains("Update or repair"))

        let unavailable = HarnessDelegationCapability(
            available: false,
            reason: "runtime_unavailable",
            remediation: "Install the current engine runtime, then reconnect.",
            requiresFullAccess: true
        )
        #expect(DelegationPresentation.control(
            capability: unavailable, hasFullAccess: true
        ) == .init(
            available: false,
            explanation: "Install the current engine runtime, then reconnect."
        ))
    }

    @Test func fullAccessRequirementDisablesOtherwiseReadyControl() {
        let capable = HarnessDelegationCapability(
            available: true, reason: "ready", requiresFullAccess: true)
        let workspaceWrite = DelegationPresentation.control(
            capability: capable, hasFullAccess: false)
        #expect(!workspaceWrite.available)
        #expect(workspaceWrite.explanation.contains("Choose Full access"))
        #expect(DelegationPresentation.control(
            capability: capable, hasFullAccess: true).available)
    }

    @Test func autoPoolNeedsOneCapableAccessCompatibleRoute() {
        let unsupported = HarnessDelegationCapability(
            available: false, reason: "manifest_unsupported", requiresFullAccess: false)
        let ready = HarnessDelegationCapability(
            available: true, reason: "ready", requiresFullAccess: false)
        #expect(DelegationPresentation.control(
            capabilities: [unsupported, ready], hasFullAccess: false).available)
    }

    @Test func emptyAndMixedUnavailablePoolsExplainTheActualSelection() {
        let empty = DelegationPresentation.control(
            capabilities: [], hasFullAccess: true)
        #expect(!empty.available)
        #expect(empty.explanation.contains("No routable harness is selected"))

        let runtimeUnavailable = HarnessDelegationCapability(
            available: false, reason: "runtime_unavailable", requiresFullAccess: false)
        let manifestUnsupported = HarnessDelegationCapability(
            available: false, reason: "manifest_unsupported", requiresFullAccess: false)
        let mixed = DelegationPresentation.control(
            capabilities: [runtimeUnavailable, manifestUnsupported], hasFullAccess: true)
        #expect(!mixed.available)
        #expect(mixed.explanation.contains("No selected route can host Delegate"))
    }

    @Test func staleOnToggleCannotSendAfterRouteBecomesUnavailable() {
        let unavailable = DelegationPresentation.ControlState(
            available: false, explanation: "Update the runtime.")
        #expect(!DelegationPresentation.visibleToggleValue(
            isOn: true, control: unavailable))
        #expect(!DelegationPresentation.requestedForWire(
            isOn: true, control: unavailable))

        let available = DelegationPresentation.ControlState(
            available: true, explanation: "Ready")
        #expect(DelegationPresentation.requestedForWire(
            isOn: true, control: available))
        #expect(!DelegationPresentation.requestedForWire(
            isOn: false, control: available))
    }

    @Test func permissionCanRemainUnusedWithoutBeingAWarning() {
        let unused = RunDelegationInfo(
            requested: true, effective: true, used: false, reason: "injected_unused")
        #expect(DelegationPresentation.warning(unused, phase: .succeeded) == nil)
        #expect(DelegationPresentation.warning(nil, phase: .succeeded) == nil)
        let startupFailure = RunDelegationInfo(
            requested: true, effective: false, used: false, reason: "startup_failed")
        #expect(DelegationPresentation.warning(startupFailure, phase: .failed) == nil)
        let pending = RunDelegationInfo(
            requested: true, effective: false, used: false, reason: "pending")
        #expect(DelegationPresentation.warning(pending, phase: .running) == nil)
    }

    @Test func mixedPoolKeepsAProminentPartialDelegateWarning() throws {
        let partial = RunDelegationInfo(
            requested: true,
            effective: true,
            used: true,
            reason: "partially_degraded",
            remediation: "Inspect the ordinary Agent lane."
        )
        let warning = try #require(DelegationPresentation.warning(partial, phase: .succeeded))
        #expect(warning.title == "Done with warnings · one lane continued without Delegate")
        #expect(warning.detail == "Inspect the ordinary Agent lane.")
    }

    @Test func onlyClaudexorProvenanceGetsDelegatedBadgeAndParentLink() throws {
        let receipt = try #require(DelegationPresentation.childReceipt(
            delegatedFromRunId: "run-parent-12345678"))
        #expect(receipt.badge == "Delegated")
        #expect(receipt.parentLabel == "Parent · 12345678")
        #expect(receipt.parentRunId == "run-parent-12345678")

        #expect(DelegationPresentation.childReceipt(delegatedFromRunId: nil) == nil)
    }

    @Test func workspaceKeepsDelegatedChildrenFlatAndExcludesOrdinaryLineage() throws {
        let delegated = try task(#"{"runId":"child","state":"running","parentRunId":"parent","delegatedFromRunId":"parent"}"#)
        let ordinaryFollowUp = try task(#"{"runId":"follow-up","state":"succeeded","parentRunId":"parent"}"#)
        let ids = ThreadWorkspacePanel.workspaceRunIds(
            parentRunIds: ["parent"], tasks: [ordinaryFollowUp, delegated])
        #expect(ids == ["parent", "child"])
    }

    @Test func projectedChildChronologyWinsOverReverseGlobalTaskOrder() throws {
        let child1 = try task(#"{"runId":"c1","state":"succeeded","delegatedFromRunId":"p"}"#)
        let child2 = try task(#"{"runId":"c2","state":"succeeded","delegatedFromRunId":"p"}"#)
        #expect(ThreadWorkspacePanel.workspaceRunIds(
            parentRunIds: ["p", "c1", "c2"], tasks: [child2, child1]
        ) == ["p", "c1", "c2"])

        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveTasks = [child2, child1]
        #expect(model.delegatedChildren(
            of: "p", projectedIds: ["c1", "c2"]
        ).map(\.id) == ["c1", "c2"])
    }

    @Test func detailChildrenMergeIsRestorationOnlyAndLineageBounded() throws {
        var existing = try task(#"{"runId":"child","state":"running","delegatedFromRunId":"parent"}"#)
        existing.answerText = "Hydrated answer"
        let current = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"child","state":"succeeded","delegatedFromRunId":"parent"}"#.utf8)
        )
        let unrelated = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"foreign","state":"succeeded","delegatedFromRunId":"other"}"#.utf8)
        )
        let merged = AppModel.mergingDelegatedChildren(
            [current, unrelated], parentRunId: "parent", into: [existing])
        #expect(merged.map(\.id) == ["child"])
        // The parent snapshot has no child event cursor. It cannot overwrite a
        // possibly-newer existing child row with its stale summary.
        #expect(merged[0].phase == .running)
        #expect(merged[0].answerText == "Hydrated answer")
    }

    @Test func queuedChildAliasDoesNotDuplicateAfterRealRunIdBinds() throws {
        let queued = try task(#"{"jobId":"job-child","runId":"job-child","state":"queued","delegatedFromRunId":"parent"}"#)
        let bound = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"jobId":"job-child","runId":"run-child","state":"running","delegatedFromRunId":"parent"}"#.utf8))
        let merged = AppModel.mergingDelegatedChildren(
            [bound], parentRunId: "parent", into: [queued])
        #expect(merged.map(\.id) == ["job-child"])
        #expect(AppModel.restoredActiveChildIds(
            [bound], parentRunId: "parent", existingIds: ["job-child"]).isEmpty)
    }

    @Test func selectedThreadRefreshPreservesOnlyItsOffPageDelegateFamily() throws {
        let parent = try task(#"{"runId":"parent","state":"succeeded"}"#)
        let child = try task(#"{"runId":"child","state":"succeeded","delegatedFromRunId":"parent"}"#)
        let unrelated = try task(#"{"runId":"unrelated","state":"succeeded"}"#)
        let newest = try task(#"{"runId":"newest","state":"running"}"#)
        let preserved = AppModel.preservingSelectedThreadFamily(
            refreshed: [newest],
            existing: [parent, child, unrelated],
            parentRunIds: ["parent"])
        #expect(preserved.map(\.id) == ["newest", "parent", "child"])
    }

    @Test func onlyNewActiveExactLineageChildrenNeedStreams() throws {
        let active = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"active","state":"running","delegatedFromRunId":"parent"}"#.utf8))
        let terminal = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"done","state":"succeeded","delegatedFromRunId":"parent"}"#.utf8))
        let foreign = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"foreign","state":"running","delegatedFromRunId":"other"}"#.utf8))
        #expect(AppModel.restoredActiveChildIds(
            [active, terminal, foreign], parentRunId: "parent", existingIds: []) == ["active"])
        #expect(AppModel.restoredActiveChildIds(
            [active], parentRunId: "parent", existingIds: ["active"]).isEmpty)
    }
}
