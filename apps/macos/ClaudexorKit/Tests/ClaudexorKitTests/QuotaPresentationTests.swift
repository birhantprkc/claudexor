import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct QuotaPresentationTests {
    /// Fixed "now" so cooldown expiry is deterministic.
    private let now = ISO8601DateFormatter().date(from: "2026-07-16T12:00:00Z")!

    private func snapshot(
        harness: String = "claude",
        route: String = "vendor_native",
        source: String = "claude_statusline",
        observedAt: String = "2026-07-16T11:59:00Z",
        freshness: String = "fresh",
        plan: String? = "Max",
        subjectId: String? = nil,
        constraints: [[String: Any]]
    ) throws -> QuotaSnapshot {
        let object: [String: Any] = [
            "subject": [
                "harness": harness,
                "credential_route": route,
                "plan_label": plan as Any,
                "subject_id": subjectId as Any? ?? NSNull(),
            ],
            "constraints": constraints,
            "source": source,
            "observed_at": observedAt,
            "freshness": freshness,
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(QuotaSnapshot.self, from: data)
    }

    private func window(
        _ id: String, label: String, used: Double? = 0.5,
        resetsAt: String? = nil, cooldownUntil: String? = nil,
        appliesToModels: [String]? = nil
    ) -> [String: Any] {
        [
            "id": id,
            "label": label,
            "applies_to_models": appliesToModels as Any? ?? NSNull(),
            "used_ratio": used as Any,
            "window_seconds": 3600,
            "resets_at": resetsAt as Any,
            "cooldown_until": cooldownUntil as Any,
        ]
    }

    @Test func scopedExhaustionStaysScopedAndUsesServerAvailability() throws {
        let object: [String: Any] = [
            "subject": [
                "harness": "claude", "credential_route": "vendor_native",
                "plan_label": "max", "subject_id": "work",
            ],
            "constraints": [window(
                "weekly_fable", label: "Week", used: 1,
                resetsAt: "2026-08-10T00:00:00Z",
                appliesToModels: ["fable", "claude-fable-5", "best"])],
            "source": "claude_oauth_usage",
            "observed_at": "2026-08-09T00:00:00Z",
            "freshness": "fresh",
            "availability": [
                "state": "available",
                "blocking_constraints": [],
                "resets_at": NSNull(),
                "model_scoped_exhaustions": [[
                    "constraint_id": "weekly_fable",
                    "applies_to_models": ["fable", "claude-fable-5", "best"],
                    "resets_at": "2026-08-10T00:00:00Z",
                ]],
            ],
        ]
        let snapshot = try JSONDecoder().decode(
            QuotaSnapshot.self,
            from: JSONSerialization.data(withJSONObject: object))
        let group = try #require(QuotaPresentation.groups(from: [snapshot]).first)

        #expect(group.availability?.state == "available")
        #expect(group.hasOnlyScopedWindows)
        #expect(group.scopedExhaustions.map(\.scopeLabel) == ["Fable only"])
        #expect(group.windows.first?.appliesToModels == ["fable", "claude-fable-5", "best"])
    }

    @Test func availabilityFoldUnionsScopedExhaustionsWithoutRatioInference() throws {
        func decorated(_ source: String, availability: [String: Any]) throws -> QuotaSnapshot {
            let object: [String: Any] = [
                "subject": [
                    "harness": "claude", "credential_route": "vendor_native",
                    "plan_label": "max", "subject_id": "work",
                ],
                "constraints": [],
                "source": source,
                "observed_at": source == "claude_oauth_usage"
                    ? "2026-08-09T00:00:02Z" : "2026-08-09T00:00:01Z",
                "freshness": "fresh",
                "availability": availability,
            ]
            return try JSONDecoder().decode(
                QuotaSnapshot.self,
                from: JSONSerialization.data(withJSONObject: object))
        }
        let primary = try decorated("claude_oauth_usage", availability: [
            "state": "exhausted",
            "blocking_constraints": ["five_hour"],
            "resets_at": "2026-08-09T13:00:00Z",
            "model_scoped_exhaustions": [[
                "constraint_id": "weekly_fable", "applies_to_models": ["fable"],
                "resets_at": "2026-08-10T00:00:00Z",
            ]],
        ])
        let reactive = try decorated("claude_api_retry", availability: [
            "state": "cooldown",
            "blocking_constraints": ["cooldown"],
            "resets_at": "2026-08-09T12:30:00Z",
            "model_scoped_exhaustions": [[
                "constraint_id": "weekly_fable", "applies_to_models": ["fable"],
                "resets_at": "2026-08-10T00:00:00Z",
            ]],
        ])
        let group = try #require(QuotaPresentation.groups(from: [reactive, primary]).first)

        #expect(group.availability?.state == "exhausted")
        #expect(group.availability?.blockingConstraints == ["cooldown", "five_hour"])
        #expect(group.availability?.resetsAt == "2026-08-09T12:30:00Z")
        #expect(group.scopedExhaustions.count == 1)
    }

    @Test func everyPrimaryWindowSurvivesGrouping() throws {
        let usage = try snapshot(constraints: [
            window("w5h", label: "5h", used: 0.63, resetsAt: "2026-07-16T14:00:00Z"),
            window("wweek", label: "Week", used: 0.41, resetsAt: "2026-07-20T00:00:00Z"),
        ])
        let groups = QuotaPresentation.groups(from: [usage], now: now)
        #expect(groups.count == 1)
        #expect(groups.first?.windows.map(\.id) == ["w5h", "wweek"])
        #expect(groups.first?.nextResetAt == "2026-07-16T14:00:00Z")
        #expect(groups.first?.routeLabel == "Subscription")
    }

    @Test func duplicateCooldownSnapshotFoldsIntoOneGroupWithBadge() throws {
        // The server keeps cooldown as a SEPARATE snapshot (source
        // claude_api_retry) that clones the usage windows it knew about —
        // naively that is a second card. It must fold into the SAME group:
        // one copy of each window, cooldown as a badge, no extra card.
        let usage = try snapshot(
            observedAt: "2026-07-16T11:59:00Z",
            constraints: [window("w5h", label: "5h", used: 0.63)]
        )
        let cooldown = try snapshot(
            source: "claude_api_retry",
            observedAt: "2026-07-16T11:30:00Z",
            constraints: [
                window("w5h", label: "5h", used: 0.60),
                window("cooldown", label: "Cooldown", used: nil, cooldownUntil: "2026-07-16T12:30:00Z"),
            ]
        )
        let groups = QuotaPresentation.groups(from: [usage, cooldown], now: now)
        #expect(groups.count == 1)
        let group = try #require(groups.first)
        // Superseded copy hidden: the newer usage snapshot's 63% wins.
        #expect(group.windows.map(\.id) == ["w5h"])
        #expect(group.windows.first?.usedRatio == 0.63)
        // Cooldown rides as a badge, never as a window row.
        #expect(group.cooldownUntil == "2026-07-16T12:30:00Z")
        #expect(group.sources.count == 2)
    }

    @Test func expiredCooldownIsHidden() throws {
        let cooldown = try snapshot(
            source: "claude_api_retry",
            constraints: [
                window("cooldown", label: "Cooldown", used: nil, cooldownUntil: "2026-07-16T11:00:00Z")
            ]
        )
        let groups = QuotaPresentation.groups(from: [cooldown], now: now)
        #expect(groups.first?.cooldownUntil == nil)
        #expect(groups.first?.windows.isEmpty == true)
    }

    @Test func credentialProfilesOfOneRouteStaySeparateGroups() throws {
        // INV-135: two claude subscriptions (default + profile) must never
        // merge into one chip — each carries its own windows and signature.
        let base = try snapshot(
            source: "claude_oauth_usage",
            constraints: [window("five_hour", label: "5 hour", used: 0.10)]
        )
        let profile = try snapshot(
            source: "claude_oauth_usage",
            plan: "max",
            subjectId: "exp-a",
            constraints: [window("five_hour", label: "5 hour", used: 0.45)]
        )
        let groups = QuotaPresentation.groups(from: [base, profile])
        #expect(groups.count == 2)
        let byId = Dictionary(uniqueKeysWithValues: groups.map { ($0.subjectId ?? "default", $0) })
        #expect(byId["default"]?.windows.first?.usedRatio == 0.10)
        #expect(byId["exp-a"]?.windows.first?.usedRatio == 0.45)
        #expect(byId["exp-a"]?.planLabel == "max")
    }

    @Test func routesOfOneHarnessStaySeparateGroups() throws {
        let native = try snapshot(route: "vendor_native", constraints: [window("w5h", label: "5h")])
        let api = try snapshot(
            route: "managed_api_key", source: "claude_api_retry",
            constraints: [window("wapi", label: "API")]
        )
        let groups = QuotaPresentation.groups(from: [native, api], now: now)
        #expect(groups.count == 2)
        #expect(Set(groups.map(\.routeLabel)) == ["Subscription", "API key"])
    }

    @Test func credentialRouteHumanizerCoversEveryWireValueAndDegradesHonestly() {
        #expect(humanizeCredentialRoute("vendor_native") == "Subscription")
        #expect(humanizeCredentialRoute("managed_api_key") == "API key")
        #expect(humanizeCredentialRoute("local") == "Local")
        #expect(humanizeCredentialRoute("future_route") == "Future Route")
    }

    @Test func modelsRouteParamMapsPreferencesAndLeavesAutoUnfiltered() {
        #expect(modelsRouteParam(forAuthPreference: "subscription") == "local_session")
        #expect(modelsRouteParam(forAuthPreference: "api_key") == "api_key")
        #expect(modelsRouteParam(forAuthPreference: "auto") == nil)
        #expect(modelsRouteParam(forAuthPreference: nil) == nil)
    }

    @Test func harnessModelDecodesRouteAnnotationsAndRunSummaryDecodesAuthRoute() throws {
        let annotated = try JSONDecoder().decode(
            HarnessModel.self,
            from: Data(#"{"id":"gpt-5.6-sol","label":null,"context_window":null,"routes":["api_key"]}"#.utf8)
        )
        #expect(annotated.routes == ["api_key"])
        let bare = try JSONDecoder().decode(
            HarnessModel.self, from: Data(#"{"id":"gpt-5.6-sol"}"#.utf8)
        )
        #expect(bare.routes == nil)

        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(#"""
        {"runId":"run-1","state":"succeeded","authRoute":{
          "requested":"auto","effective":"subscription","source":"native_session",
          "reason":"native_first","harnessId":"claude","attemptId":"a01",
          "profileId":"work",
          "modelMismatch":{"requested":"claude-fable-5","observed":"claude-opus-4-8"}
        }}
        """#.utf8))
        #expect(summary.authRoute?.effective == "subscription")
        #expect(summary.authRoute?.profileId == "work")
        #expect(summary.authRoute?.modelMismatch == RunAuthRoute.ModelMismatch(
            requested: "claude-fable-5", observed: "claude-opus-4-8"
        ))
    }
}
