import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

struct SettingsAutosaveTests {
    private func jsonKeys(_ edit: GlobalSettingsEdit) throws -> Set<String> {
        guard case .valid(let patch) = edit.validation else {
            Issue.record("Expected a valid settings edit")
            return []
        }
        let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch))
        guard let object = value as? [String: Any] else { return [] }
        return Set(object.keys)
    }

    @Test func everyGlobalEditBuildsItsExactPartialPatch() throws {
        let edits: [(GlobalSettingsEdit, String)] = [
            (.routingGoal("economy", qualityTierCount: 0), "routingGoal"),
            (.paidFallback("never"), "paidFallback"),
            (.primaryHarness(nil), "primaryHarness"),
            (.eligibleHarnesses(["claude", "codex"]), "eligibleHarnesses"),
            (.envInheritance("clean"), "envInheritance"),
            (.authPreference("subscription"), "authPreference"),
            (.paidBudget(.finite(maxUsd: 12.5)), "paidBudgetPerRun"),
            (.interactionTimeout(.finiteMinutes("15")), "interactionTimeoutMs"),
            (.interactionTimeout(.disabled), "interactionTimeoutMs"),
        ]
        for (edit, key) in edits {
            #expect(try jsonKeys(edit) == [key])
        }
    }

    @Test func interactionTimeoutHasOneTypedFiniteOrDisabledParser() throws {
        guard case .valid(let disabled) = GlobalSettingsEdit.interactionTimeout(.disabled).validation else {
            Issue.record("Disabled timeout must be valid")
            return
        }
        let raw = String(data: try JSONEncoder().encode(disabled), encoding: .utf8) ?? ""
        #expect(raw.contains("\"interactionTimeoutMs\":null"))

        guard case .valid(let finite) = GlobalSettingsEdit.interactionTimeout(.finiteMinutes("16")).validation else {
            Issue.record("Finite timeout must be valid")
            return
        }
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(finite)) as? [String: Any]
        #expect(object?["interactionTimeoutMs"] as? Int == 960_000)

        #expect(GlobalSettingsEdit.interactionTimeout(.finiteMinutes("")).validation.isInvalid)
        #expect(GlobalSettingsEdit.interactionTimeout(.finiteMinutes("0")).validation.isInvalid)
        #expect(GlobalSettingsEdit.interactionTimeout(.finiteMinutes("-1")).validation.isInvalid)
        #expect(GlobalSettingsEdit.interactionTimeout(.finiteMinutes("1.5")).validation.isInvalid)
        #expect(GlobalSettingsEdit.interactionTimeout(
            .finiteMinutes("9007199254740992")
        ).validation.isInvalid)
        #expect(!GlobalSettingsEdit.interactionTimeout(
            .finiteMinutes("133333333333")
        ).validation.isInvalid)
        #expect(GlobalSettingsEdit.interactionTimeout(
            .finiteMinutes("133333333334")
        ).validation.isInvalid)

        let maxSnapshot = try snapshot(
            goal: "auto",
            fallback: "never",
            timeout: InteractionTimeoutContract.maxFiniteMilliseconds
        )
        let maxDraft = GlobalSettingsDraft.from(maxSnapshot)
        #expect(maxDraft.interactionTimeoutMinutes == "133333333333")
        #expect(!maxDraft.edit(for: .interactionTimeout, qualityTierCount: 0)
            .validation.isInvalid)
    }

    @Test func qualityWithoutTiersAndInvalidFiniteBudgetNeverBuildRequests() {
        #expect(GlobalSettingsEdit.routingGoal("quality", qualityTierCount: 0).validation.isInvalid)
        #expect(GlobalSettingsEdit.paidBudgetDraft(unlimited: false, amount: "").validation.isInvalid)
        #expect(GlobalSettingsEdit.paidBudgetDraft(unlimited: false, amount: "-1").validation.isInvalid)
        #expect(!GlobalSettingsEdit.paidBudgetDraft(unlimited: true, amount: "garbage").validation.isInvalid)
    }

    @Test func staleCompletionCannotSettleANewerGeneration() {
        var reducer = SettingsLaneReducer()
        let first = reducer.admit(validationError: nil)
        let beganFirst = reducer.beginSave(generation: first)
        #expect(beganFirst)
        let second = reducer.admit(validationError: nil)

        #expect(reducer.complete(generation: first, outcome: .saved) == .saveTrailing)
        #expect(reducer.phase == .queued)
        let beganSecond = reducer.beginSave(generation: second)
        #expect(beganSecond)
        #expect(reducer.complete(generation: second, outcome: .failed("offline")) == .settled)
        #expect(reducer.phase == .failed("offline"))

        let retry = reducer.admit(validationError: nil)
        #expect(retry > second)
        #expect(reducer.phase == .queued)
    }

    @Test func staleCompletionBeforeDebounceLeavesNewestEditEditing() {
        var reducer = SettingsLaneReducer()
        let old = reducer.admit(validationError: nil)
        let beganOld = reducer.beginSave(generation: old)
        #expect(beganOld)
        let newest = reducer.admit(validationError: nil, debounced: true)

        #expect(reducer.complete(generation: old, outcome: .saved) == .settled)
        #expect(reducer.phase == .editing)
        let queued = reducer.queue(generation: newest)
        #expect(queued)
        let beganNewest = reducer.beginSave(generation: newest)
        #expect(beganNewest)
        #expect(reducer.complete(generation: newest, outcome: .saved) == .settled)
        #expect(reducer.phase == .saved)
    }

    @Test func staleFailureAfterDebounceConsumesExactlyOneQueuedTrailingSave() {
        var reducer = SettingsLaneReducer()
        let old = reducer.admit(validationError: nil)
        let beganOld = reducer.beginSave(generation: old)
        #expect(beganOld)
        let newest = reducer.admit(validationError: nil, debounced: true)
        let queuedNewest = reducer.queue(generation: newest)
        #expect(queuedNewest)

        #expect(reducer.complete(generation: old, outcome: .failed("old")) == .saveTrailing)
        #expect(reducer.phase == .queued)
        let beganNewest = reducer.beginSave(generation: newest)
        #expect(beganNewest)
        let duplicateBegan = reducer.beginSave(generation: newest)
        #expect(!duplicateBegan)
        #expect(reducer.complete(generation: newest, outcome: .saved) == .settled)
        #expect(reducer.phase == .saved)
    }

    @Test func staleSuccessAfterDebounceConsumesExactlyOneQueuedTrailingSave() {
        var reducer = SettingsLaneReducer()
        let old = reducer.admit(validationError: nil)
        let beganOld = reducer.beginSave(generation: old)
        #expect(beganOld)
        let newest = reducer.admit(validationError: nil, debounced: true)
        let queuedNewest = reducer.queue(generation: newest)
        #expect(queuedNewest)

        #expect(reducer.complete(generation: old, outcome: .saved) == .saveTrailing)
        let beganNewest = reducer.beginSave(generation: newest)
        #expect(beganNewest)
        let duplicateBegan = reducer.beginSave(generation: newest)
        #expect(!duplicateBegan)
        #expect(reducer.complete(generation: newest, outcome: .saved) == .settled)
        #expect(reducer.phase == .saved)
    }

    @Test func everyHarnessLaneBuildsOnlyItsOwnedNestedKeys() throws {
        let edits: [(HarnessSettingsEdit, Set<String>)] = [
            (.enabled(false), ["enabled"]),
            (
                .modelAndEffort(modelDraft: "gpt-5.6", effort: "high", modelEditable: true),
                ["defaultModel", "effort"]
            ),
            (.web("off"), ["web"]),
            (.toolsAllow("read, write"), ["toolsAllow"]),
            (.toolsDeny("shell"), ["toolsDeny"]),
            (.fallbackModel("backup"), ["fallbackModel"]),
        ]
        for (edit, expected) in edits {
            #expect(try harnessJSONKeys(edit) == expected)
        }
        #expect(
            try harnessJSONKeys(
                .modelAndEffort(
                    modelDraft: "legacy-model",
                    effort: "high",
                    modelEditable: false
                )
            ) == ["effort"]
        )
    }

    @Test func everyHarnessLaneEncodesItsExactNestedJSON() throws {
        #expect(try harnessJSONString(.enabled(false))
            == #"{"harnesses":{"claude":{"enabled":false}}}"#)
        #expect(try harnessJSONString(.web("off"))
            == #"{"harnesses":{"claude":{"web":"off"}}}"#)
        #expect(try harnessJSONString(.toolsAllow("read, write"))
            == #"{"harnesses":{"claude":{"toolsAllow":["read","write"]}}}"#)
        #expect(try harnessJSONString(.toolsDeny("shell"))
            == #"{"harnesses":{"claude":{"toolsDeny":["shell"]}}}"#)
        #expect(try harnessJSONString(.fallbackModel(""))
            == #"{"harnesses":{"claude":{"fallbackModel":null}}}"#)
        #expect(try harnessJSONString(.modelAndEffort(
            modelDraft: "gpt-5.6", effort: "high", modelEditable: true
        )) == #"{"harnesses":{"claude":{"defaultModel":"gpt-5.6","effort":"high"}}}"#)
        #expect(try harnessJSONString(.modelAndEffort(
            modelDraft: "legacy", effort: "__default", modelEditable: false
        )) == #"{"harnesses":{"claude":{"effort":null}}}"#)
    }

    @Test func harnessSnapshotEchoAdoptsExternalSiblingsButPreservesOwnedLane() throws {
        var draft = HarnessSettingsDraft.from(try harnessSettings(
            enabled: true, web: "auto", fallback: "old", allow: ["read"]
        ))
        draft.web = "off"
        draft.adopt(
            try harnessSettings(
                enabled: false, web: "live", fallback: "external", allow: ["read", "write"]
            ),
            preserving: [.web]
        )

        #expect(draft.web == "off")
        #expect(draft.enabled == false)
        #expect(draft.fallbackDraft == "external")
        #expect(draft.toolsAllowDraft == "read, write")
        #expect(try harnessJSONKeys(draft.edit(for: .web, modelEditable: true)) == ["web"])
    }

    @Test func locationAndLaneAreBothPartOfAutosaveOwnership() {
        let remote = ExecutionLocationID.remote(UUID())
        let localBudget = SettingsLaneKey(locationID: .local, lane: .paidBudget)
        let remoteBudget = SettingsLaneKey(locationID: remote, lane: .paidBudget)
        let localTimeout = SettingsLaneKey(locationID: .local, lane: .interactionTimeout)
        #expect(localBudget != remoteBudget)
        #expect(localBudget != localTimeout)

        let localClaude = HarnessSettingsScopeKey(locationID: .local, harnessID: "claude")
        let localCodex = HarnessSettingsScopeKey(locationID: .local, harnessID: "codex")
        let remoteClaude = HarnessSettingsScopeKey(locationID: remote, harnessID: "claude")
        #expect(
            HarnessSettingsLaneKey(scope: localClaude, lane: .web)
                != HarnessSettingsLaneKey(scope: localCodex, lane: .web)
        )
        #expect(
            HarnessSettingsLaneKey(scope: localClaude, lane: .web)
                != HarnessSettingsLaneKey(scope: remoteClaude, lane: .web)
        )
    }

    @Test func harnessFailureDraftAndRetrySurviveLocationRoundTrip() throws {
        let remoteID = ExecutionLocationID.remote(UUID())
        let local = HarnessSettingsScopeKey(locationID: .local, harnessID: "claude")
        let remote = HarnessSettingsScopeKey(locationID: remoteID, harnessID: "claude")
        let localWeb = HarnessSettingsLaneKey(scope: local, lane: .web)
        let remoteWeb = HarnessSettingsLaneKey(scope: remote, lane: .web)
        var state = HarnessSettingsAutosaveState()

        var localDraft = HarnessSettingsDraft.from(try harnessSettings(
            enabled: true, web: "auto", fallback: "", allow: []
        ))
        localDraft.web = "off"
        state.drafts[local] = localDraft
        var failed = SettingsLaneReducer()
        let failedGeneration = failed.admit(validationError: nil)
        let failedBegan = failed.beginSave(generation: failedGeneration)
        let failedSettled = failed.complete(
            generation: failedGeneration,
            outcome: .failed("offline")
        )
        #expect(failedBegan)
        #expect(failedSettled == .settled)
        state.laneReducers[localWeb] = failed

        state.hydrate(
            try harnessSettings(enabled: true, web: "live", fallback: "remote", allow: []),
            at: remote
        )
        state.hydrate(
            try harnessSettings(enabled: true, web: "auto", fallback: "server", allow: []),
            at: local
        )

        #expect(state.draft(at: local, serverSettings: nil).web == "off")
        #expect(state.laneReducers[localWeb]?.phase == .failed("offline"))
        #expect(state.draft(at: remote, serverSettings: nil).web == "live")
        #expect(state.laneReducers[remoteWeb] == nil)

        var retry = state.laneReducers[localWeb] ?? SettingsLaneReducer()
        _ = retry.admit(validationError: nil)
        state.laneReducers[localWeb] = retry
        #expect(state.laneReducers[localWeb]?.phase == .queued)
        #expect(
            try harnessJSONString(
                state.draft(at: local, serverSettings: nil)
                    .edit(for: .web, modelEditable: true)
            ) == #"{"harnesses":{"claude":{"web":"off"}}}"#
        )
    }

    @Test func harnessDebounceAndSuccessHydrationRemainScoped() throws {
        let remoteID = ExecutionLocationID.remote(UUID())
        let local = HarnessSettingsScopeKey(locationID: .local, harnessID: "claude")
        let remote = HarnessSettingsScopeKey(locationID: remoteID, harnessID: "claude")
        let localTools = HarnessSettingsLaneKey(scope: local, lane: .toolsAllow)
        var state = HarnessSettingsAutosaveState()
        var localDraft = HarnessSettingsDraft.from(try harnessSettings(
            enabled: true, web: "auto", fallback: "", allow: ["read"]
        ))
        localDraft.toolsAllowDraft = "read, write"
        state.drafts[local] = localDraft

        var editing = SettingsLaneReducer()
        let generation = editing.admit(validationError: nil, debounced: true)
        state.laneReducers[localTools] = editing
        state.hydrate(
            try harnessSettings(enabled: true, web: "live", fallback: "", allow: []),
            at: remote
        )
        state.hydrate(
            try harnessSettings(enabled: true, web: "auto", fallback: "", allow: ["server"]),
            at: local
        )
        #expect(state.draft(at: local, serverSettings: nil).toolsAllowDraft == "read, write")
        #expect(state.laneReducers[localTools]?.phase == .editing)

        let queued = editing.queue(generation: generation)
        let began = editing.beginSave(generation: generation)
        let settled = editing.complete(generation: generation, outcome: .saved)
        #expect(queued)
        #expect(began)
        #expect(settled == .settled)
        state.laneReducers[localTools] = editing
        state.hydrate(
            try harnessSettings(enabled: true, web: "auto", fallback: "", allow: ["server-applied"]),
            at: local
        )
        #expect(state.draft(at: local, serverSettings: nil).toolsAllowDraft == "server-applied")
        #expect(state.draft(at: remote, serverSettings: nil).web == "live")
    }

    @Test func programmaticSnapshotEchoOnlyAdoptsServerOwnedLanes() throws {
        let initial = try snapshot(goal: "auto", fallback: "never", timeout: 900_000)
        var draft = GlobalSettingsDraft.from(initial)
        draft.routingGoal = "economy"
        draft.interactionTimeoutMinutes = "30"

        let echo = try snapshot(
            goal: "quality",
            fallback: "allowed_within_cap",
            timeout: 1_200_000
        )
        draft.adopt(echo, preserving: [.routingGoal, .interactionTimeout])

        #expect(draft.routingGoal == "economy")
        #expect(draft.interactionTimeoutMinutes == "30")
        #expect(draft.paidFallback == "allowed_within_cap")
    }

    @Test func admittedPatchAndLocationAreValuesFrozenBeforeDebounce() throws {
        var draft = GlobalSettingsDraft.defaults
        draft.routingGoal = "economy"
        let remote = ExecutionLocationID.remote(UUID())
        let admitted = AdmittedSettingsEdit(
            edit: draft.edit(for: .routingGoal, qualityTierCount: 0),
            target: SettingsSaveTarget(locationID: remote, generation: 7),
            generation: 3
        )
        draft.routingGoal = "quality"

        #expect(try jsonKeys(admitted.edit) == ["routingGoal"])
        guard case .valid(let patch) = admitted.edit.validation else {
            Issue.record("Expected captured edit to remain valid")
            return
        }
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch))
            as? [String: Any]
        #expect(object?["routingGoal"] as? String == "economy")
        #expect(admitted.target.locationID == remote)
        #expect(admitted.target.generation == 7)
    }

    private func harnessJSONKeys(_ edit: HarnessSettingsEdit) throws -> Set<String> {
        guard case .valid(let request) = edit.validation(harnessID: "claude") else {
            Issue.record("Expected valid harness edit")
            return []
        }
        let root = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request))
            as? [String: Any]
        let harnesses = root?["harnesses"] as? [String: Any]
        guard let patch = harnesses?["claude"] as? [String: Any] else {
            Issue.record("Expected a nested harness patch")
            return []
        }
        return Set(patch.keys)
    }

    private func harnessJSONString(_ edit: HarnessSettingsEdit) throws -> String {
        guard case .valid(let request) = edit.validation(harnessID: "claude") else {
            Issue.record("Expected valid harness edit")
            return ""
        }
        let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request))
        let normalized = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return String(data: normalized, encoding: .utf8) ?? ""
    }

    private func harnessSettings(
        enabled: Bool,
        web: String,
        fallback: String,
        allow: [String]
    ) throws -> HarnessSettings {
        let data = try JSONSerialization.data(withJSONObject: [
            "enabled": enabled,
            "defaultModel": NSNull(),
            "effort": NSNull(),
            "maxTurns": NSNull(),
            "maxRounds": NSNull(),
            "toolsAllow": allow,
            "toolsDeny": [],
            "fallbackModel": fallback,
            "web": web,
            "authPreference": NSNull(),
            "profileLimitAction": NSNull(),
        ])
        return try JSONDecoder().decode(HarnessSettings.self, from: data)
    }

    private func snapshot(goal: String, fallback: String, timeout: Int) throws -> SettingsSnapshot {
        let json = """
        {
          "sources": [],
          "routing": {
            "goal": "\(goal)",
            "paidFallback": "\(fallback)",
            "qualityTiers": {},
            "primaryHarness": null,
            "eligibleHarnesses": [],
            "envInheritance": "mirror_native",
            "authPreference": "auto"
          },
          "budget": { "paidBudgetPerRun": { "kind": "unlimited" } },
          "runtime": null,
          "harnesses": {},
          "interactionTimeoutMs": \(timeout)
        }
        """
        return try JSONDecoder().decode(SettingsSnapshot.self, from: Data(json.utf8))
    }
}
