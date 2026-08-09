import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct BudgetQuotaModelsTests {
    @Test func paidBudgetUsesAnExplicitTaggedWireShape() throws {
        let finite = PaidBudget.finite(maxUsd: 0)
        let data = try JSONEncoder().encode(finite)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["kind"] as? String == "finite")
        #expect(object["maxUsd"] as? Double == 0)
        #expect(try JSONDecoder().decode(PaidBudget.self, from: Data(#"{"kind":"unlimited"}"#.utf8)) == .unlimited)
    }

    @Test func quotaDecodesTheExactDaemonWireGolden() throws {
        let url = try #require(Bundle.module.url(
            forResource: "control-quota-response", withExtension: "json", subdirectory: "Fixtures"
        ))
        let response = try JSONDecoder().decode(
            ControlQuotaResponse.self,
            from: Data(contentsOf: url)
        )
        #expect(response.snapshots.first?.constraints.count == 2)
        #expect(response.snapshots.first?.constraints.last?.usedRatio == nil)
        #expect(response.snapshots.first?.subject.credentialRoute == "vendor_native")
        #expect(response.refreshedAt == "2026-07-15T10:00:01.000Z")
    }

    @Test func quotaDecodesOptionalServerAvailabilityAndModelScopes() throws {
        let response = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native",
          "plan_label":"max","subject_id":"work"},"constraints":[{"id":"weekly_fable",
          "label":"Week","applies_to_models":["fable"],"used_ratio":1,
          "window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],
          "source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
          "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
          "model_scoped_exhaustions":[{"constraint_id":"weekly_fable",
          "applies_to_models":["fable"],"resets_at":"2026-08-10T00:00:00Z"}]}}],
          "absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let snapshot = try #require(response.snapshots.first)
        #expect(snapshot.constraints.first?.appliesToModels == ["fable"])
        #expect(snapshot.availability?.state == "available")
        #expect(snapshot.availability?.blockingConstraints.isEmpty == true)
        #expect(snapshot.availability?.modelScopedExhaustions.first?.constraintId == "weekly_fable")
        #expect(snapshot.availability?.modelScopedExhaustions.first?.appliesToModels == ["fable"])
    }

    // Ф2 valuation fields (QA-023c): an UNKNOWN valuation stays absent and is
    // NEVER coerced to a fake $0; a KNOWN valuation surfaces.
    @Test func budgetSnapshotHonorsUnknownValuation() throws {
        let json = #"""
        {"paidBudget":{"kind":"unlimited"},"spendUsd":null,"remainingUsd":null,
         "estimated":false,"source":"unknown"}
        """#
        let snap = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(json.utf8))
        #expect(snap.valuationKnowledge == "unknown")
        #expect(snap.valuationUsd == nil)
        #expect(snap.knownValuationUsd == nil)  // absent, never $0
        #expect(snap.evidence == "complete")
    }

    @Test func budgetSnapshotSurfacesKnownValuationAndEvidence() throws {
        let json = #"""
        {"paidBudget":{"kind":"unlimited"},"spendUsd":0,"valuationUsd":0.87,
         "valuationKnowledge":"estimated","remainingUsd":null,"estimated":false,
         "source":"events","evidence":"incomplete"}
        """#
        let snap = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(json.utf8))
        #expect(snap.spendUsd == 0)
        #expect(snap.valuationKnowledge == "estimated")
        #expect(snap.knownValuationUsd == 0.87)  // cash $0 + known valuation is honest
        #expect(snap.evidence == "incomplete")
    }

    // Ф2 Implement-plan provenance (QA-046): planHash + planReadinessOverridden
    // round-trip; null/false on non-Implement turns.
    @Test func threadTurnDecodesPlanProvenance() throws {
        let implemented = #"""
        {"id":"tn-5","threadId":"th-1","runId":"run-6","planRunId":"run-plan-1",
         "planHash":"aaaa","planReadinessOverridden":true,"kind":"followup",
         "prompt":"implement","createdAt":"2026-07-19T12:00:00.000Z"}
        """#
        let turn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(implemented.utf8))
        #expect(turn.planHash == "aaaa")
        #expect(turn.planReadinessOverridden == true)

        let plain = #"""
        {"id":"tn-1","threadId":"th-1","planHash":null,"planReadinessOverridden":false,
         "kind":"initial","prompt":"add","createdAt":"2026-07-19T12:00:00.000Z"}
        """#
        let plainTurn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(plain.utf8))
        #expect(plainTurn.planHash == nil)
        #expect(plainTurn.planReadinessOverridden == false)
    }
}
