import Foundation
import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// Owner dogfood: the internal profile id is DERIVED, never typed. The
/// generator must always emit a server-valid slug, unique per harness.
@Suite struct AccountsPresentationTests {
    /// Antigravity registers named profiles (so it belongs in the config-dir
    /// login set) but has NO default credential store, so it must NOT gain a
    /// `defaultAuthReadinessRequest`: that field is what emits the default
    /// "CLI login" row, and for agy it would be a row with nothing behind it.
    /// The two facts are one decision, so they are pinned together.
    @Test func antigravitySignsInAsNamedProfilesWithoutAPhantomCliLoginRow() {
        #expect(AccountsPresentation.configDirLoginHarnessIds.contains("agy"))
        #expect(HarnessFamily(rawValue: "agy").defaultAuthReadinessRequest == nil)
        // Every OTHER config-dir login family keeps its native default row.
        for id in AccountsPresentation.configDirLoginHarnessIds where id != "agy" {
            #expect(HarnessFamily(rawValue: id).defaultAuthReadinessRequest?.source == .nativeSession)
        }
        // Rotation is a separate question with its own owner — untouched here.
        #expect(!AccountsAutoBalance.capableHarnessIds.contains("agy"))
    }

    @Test func accountActionNoticeClearsAndRejectsLateCompletions() {
        var notice = AccountsActionNotice()
        let first = notice.begin()
        notice.settle("First refusal", generation: first)
        #expect(notice.message == "First refusal")

        let second = notice.begin()
        #expect(notice.message == nil)
        notice.settle("Late first refusal", generation: first)
        #expect(notice.message == nil)
        notice.settle("Current refusal", generation: second)
        #expect(notice.message == "Current refusal")

        let third = notice.begin()
        notice.settle(nil, generation: third)
        #expect(notice.message == nil)
    }

    @MainActor
    @Test func enabledActionReturnsBothProfileAndCliLoginRefusals() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let profile = AccountRowModel(
            id: "profile/claude/work", displayName: "Work", harnessId: "claude",
            family: .claude, readiness: .unknown, verified: false, profileId: "work",
            detail: nil, quotaGroups: [], enabled: true, nextUp: false)
        let cliLogin = AccountRowModel(
            id: "default/claude", displayName: "Claude", harnessId: "claude",
            family: .claude, readiness: .unknown, verified: false, profileId: nil,
            detail: nil, quotaGroups: [], enabled: true, nextUp: false)

        #expect(await AccountsSurface.setEnabled(profile, to: false, model: model)
            == "Engine offline — reconnect to change the account.")
        #expect(await AccountsSurface.setEnabled(cliLogin, to: false, model: model)
            == "Engine offline: reconnect before saving settings.")
    }

    @Test func crossGroupResetOrderingUsesAbsoluteInstantsAndStableFallbacks() {
        let sameInstantZ = "2026-08-09T00:00:00Z"
        let sameInstantOffset = "2026-08-09T01:00:00+01:00"
        #expect(AccountsPresentation.earliestReset(
            [sameInstantOffset, sameInstantZ]) == sameInstantZ)
        #expect(AccountsPresentation.earliestReset(
            [sameInstantZ, sameInstantOffset]) == sameInstantZ)

        // Raw lexical order says 00:30 is earlier, but the offsets make it
        // 02:30Z; the raw 03:00 value is actually the earlier 01:00Z instant.
        let lexicallyFirstButLater = "2026-08-09T00:30:00-02:00"
        let lexicallyLaterButEarlier = "2026-08-09T03:00:00+02:00"
        #expect(AccountsPresentation.earliestReset(
            [lexicallyFirstButLater, lexicallyLaterButEarlier])
            == lexicallyLaterButEarlier)

        #expect(AccountsPresentation.earliestReset(
            ["unknown-z", sameInstantZ, "unknown-a"]) == sameInstantZ)
        #expect(AccountsPresentation.earliestReset(
            ["unknown-z", "unknown-a"]) == "unknown-a")
    }

    @MainActor
    @Test func authSheetBoundaryPreservesTheOneActionLoginTarget() {
        let sheet = AuthSheet(target: AuthSheetTarget(
            family: .claude, profileId: "work", autoStartLogin: true))
        #expect(sheet.family == .claude)
        #expect(sheet.profileId == "work")
        #expect(sheet.autoStartLogin)
    }

    @MainActor
    @Test func accountReadinessRequiresExactPassedSourceVerification() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "api key ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "failed", detail: "session expired"),
        ]
        var row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)
        #expect(!row.verified)

        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "not_run"),
        ]
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unknown)

        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "unavailable",
                verification: "not_run"),
        ]
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)

        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "passed"),
        ]
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .ready)
        #expect(row.verified)
    }

    @MainActor
    @Test func accountsAvailabilityFollowsTheActiveLocationGateway() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.draftExecutionLocation = locationID
        model.health = .connected
        #expect(!AccountsPresentation.isAvailable(model: model))

        model.remoteClients[locationID] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test")
        model.health = .offline
        #expect(AccountsPresentation.isAvailable(model: model))
    }

    @MainActor
    @Test func draftAccountSelectionPersistsAndClearsInTheOneAccountsSurface() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        await model.setThreadCredentialProfile("work", harnessId: "claude")
        #expect(model.draftCredentialProfileId == "work")
        #expect(model.draftPrimaryHarness == "claude")
        #expect(model.draftEligiblePool == ["claude"])
        await model.setThreadCredentialProfile(nil)
        #expect(model.draftCredentialProfileId == nil)
    }

    @MainActor
    @Test func profileAvailabilityWithoutPassedVerificationIsNotGreen() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let json = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
        "credential_kind":"config_dir_login","enabled":true},
        "status":{"availability":"available","verification":"failed","detail":"probe failed",
        "last_verified_at":null}}
        """
        model.credentialProfiles = [
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(json.utf8)),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)
        #expect(!row.verified)
    }

    @MainActor
    @Test func profileEnabledIsSourcedFromTheWireNotFaked() throws {
        // D25 accounts symmetry: the Enabled state is wire truth (profile.enabled).
        // V11b makes the toggle LIVE (reload-after-PATCH), so it still reflects the
        // wire — a disabled profile must read as disabled.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let json = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
        "credential_kind":"config_dir_login","enabled":false},
        "status":{"availability":"available","verification":"passed","detail":null,
        "last_verified_at":null}}
        """
        model.credentialProfiles = [
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(json.utf8)),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.isProfile)
        #expect(!row.enabled)
    }

    @MainActor
    @Test func cliLoginRowDefaultsEnabledWithoutProjectionAndIsNotDeletable() throws {
        // The native vendor login is a symmetric row: never a credential profile
        // (so never Claudexor's to delete). With no V11b projection present it
        // defaults to enabled, and nextUp is false (client-fallback path).
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first { $0.isCliLogin })
        #expect(row.enabled)
        #expect(row.nextUp == false)
        #expect(!row.isProfile)
        #expect(row.profileId == nil)
    }

    @MainActor
    @Test func nextUpProfileAndCliEnabledBindToServerProjection() throws {
        // F1 engine cut: the informational next-up hint and the CLI-login Enabled
        // state come from the server accounts projection (`next_up`), not client
        // pin state — and there is no user-settable Active any more.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}},
         {"profile":{"profile_id":"spare","harness_id":"claude","display_name":"Spare",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        // Projection: routing would pick "work" next; the native login is DISABLED.
        let accountsJSON = """
        [{"harness_id":"claude","native_credentials_enabled":false,
          "native_login_detected":true,"next_up":{"kind":"profile","profileId":"work"}}]
        """
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self, from: Data(accountsJSON.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        #expect(cli.enabled == false)     // driven by native_credentials_enabled
        #expect(cli.nextUp == false)      // a profile is next up, not the native login
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.nextUp == true)
        let spare = try #require(rows.first { $0.profileId == "spare" })
        #expect(spare.nextUp == false)
    }

    @MainActor
    @Test func nativeNextUpMarksTheCliLoginRow() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        // Projection: routing would pick the native/CLI login next.
        let accountsJSON = """
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":true,"next_up":{"kind":"native","route":"local_session"}}]
        """
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self, from: Data(accountsJSON.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        #expect(cli.enabled == true)
        #expect(cli.nextUp == true)
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.nextUp == false)
    }

    @MainActor
    @Test func apiKeyRouteUsesTheExistingRouteLabelWithoutCreatingAnAccount() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .raw, health: .ok, version: "1", auth: "key ready",
            intents: ["implement"], routableIntents: ["implement"])]
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self,
            from: Data(#"[{"harness_id":"raw-api","native_credentials_enabled":true,"native_login_detected":false,"next_up":{"kind":"native","route":"api_key"}}]"#.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        #expect(AccountsPresentation.rows(model: model).isEmpty)
        #expect(AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "raw-api", pinnedProfileId: nil
        ).label == "Automatic")
    }

    @MainActor
    @Test func apiKeyFallbackDoesNotMarkTheCliLoginRowAsNextUp() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "key ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "unavailable", verification: "failed"),
        ]
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self,
            from: Data(#"[{"harness_id":"claude","native_credentials_enabled":true,"native_login_detected":false,"next_up":{"kind":"native","route":"api_key"}}]"#.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        let cli = try #require(AccountsPresentation.rows(model: model).first { $0.isCliLogin })
        #expect(cli.nextUp == false)
        #expect(AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil
        ).label == "Automatic")
    }

    @MainActor
    @Test func identityLineBindsToTheDaemonProjectionAndFallsBackToDetail() throws {
        // INV-067: the row's secondary line is the daemon-projected {email, plan}
        // ("email · plan") when disclosed, sourced from the wire — the profile
        // entry's `identity` and the native account row's `identity`. When absent
        // the row falls back to the readiness detail.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        // "work" discloses both fields; "plan-only" discloses just the plan;
        // "bare" discloses nothing and must fall back to its status detail.
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":{"email":"work@example.test","plan":"claude_max"}},
         {"profile":{"profile_id":"plan-only","harness_id":"claude","display_name":"PlanOnly",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":{"plan":"claude_pro"}},
         {"profile":{"profile_id":"bare","harness_id":"claude","display_name":"Bare",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":null},
         {"profile":{"profile_id":"failed","harness_id":"claude","display_name":"Failed",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"unavailable","verification":"failed","detail":"login expired","last_verified_at":null},
          "identity":{"email":"old@example.test"}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        let accountsJSON = """
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":true,"identity":{"email":"native@example.test","plan":"claude_pro"},
          "next_up":{"kind":"native","route":"local_session"}}]
        """
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self, from: Data(accountsJSON.utf8))

        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        #expect(cli.identityLine == "native@example.test · claude_pro")
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.identityLine == "work@example.test · claude_max")
        #expect(work.secondaryLines == ["work@example.test · claude_max"])
        #expect(work.hiddenReadinessDetail == "probe ok")
        let planOnly = try #require(rows.first { $0.profileId == "plan-only" })
        #expect(planOnly.identityLine == "claude_pro")
        let bare = try #require(rows.first { $0.profileId == "bare" })
        #expect(bare.identityLine == nil)     // nothing disclosed → falls back to detail
        #expect(bare.detail == "probe ok")
        #expect(bare.secondaryLines == ["probe ok"])
        let failed = try #require(rows.first { $0.profileId == "failed" })
        #expect(failed.secondaryLines == ["old@example.test", "login expired"])
        #expect(failed.hiddenReadinessDetail == nil)
    }

    @MainActor
    @Test func cursorIdentityKeepsVerifiedReadinessReachableWithoutAnExtraLine() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .cursor, health: .ok, version: "1", auth: "session ready",
            authSources: [HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "passed", detail: "Native Cursor session verified")],
            intents: ["implement"])]
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self,
            from: Data(#"[{"harness_id":"cursor","native_credentials_enabled":true,"native_login_detected":true,"identity":{"email":"cursor@example.test"},"next_up":{"kind":"native","route":"local_session"}}]"#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.identityLine == "cursor@example.test")
        #expect(row.secondaryLines == ["cursor@example.test"])
        #expect(row.hiddenReadinessDetail == "Native Cursor session verified")
    }

    @Test func cliLoginBadgeExplainsLifecycleAndRouting() {
        #expect(AccountsPresentation.cliLoginLifecycleHelp ==
            "CLI login = existing vendor sign-in; named accounts = isolated profiles used by explicit pin or opt-in quota rotation.")
    }

    @MainActor
    @Test func compactPercentIgnoresScopedRatiosAndLabelsScopedExhaustion() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native",
          "plan_label":"max","subject_id":"work"},"constraints":[
          {"id":"five_hour","label":"5 hour","applies_to_models":null,"used_ratio":0.2,
           "window_seconds":18000,"resets_at":"2026-08-09T05:00:00Z","cooldown_until":null},
          {"id":"weekly_fable","label":"Week","applies_to_models":["fable"],"used_ratio":1,
           "window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],
          "source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
          "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
          "model_scoped_exhaustions":[{"constraint_id":"weekly_fable",
          "applies_to_models":["fable"],"resets_at":"2026-08-10T00:00:00Z"}]}}],
          "absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.worstPercent == 20)
        #expect(row.quotaAvailabilityState == "available")
        #expect(row.scopedQuotaLabel == "Fable only")
        #expect(AccountsPresentation.worstPercent([row]) == 20)
    }

    @MainActor
    @Test func scopedOnlyWindowsUseScopedLimitsInsteadOfAnAccountPercent() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native",
          "plan_label":"max","subject_id":"work"},"constraints":[{"id":"weekly_fable",
          "label":"Week","applies_to_models":["fable"],"used_ratio":0.5,
          "window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],
          "source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
          "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
          "model_scoped_exhaustions":[]}}],"absences":[],
          "refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.worstPercent == nil)
        #expect(row.scopedQuotaLabel == "Scoped limits")
        #expect(AccountsPresentation.worstPercent([row]) == nil)
    }

    @MainActor
    @Test func accountRowColumnSetIsStableAcrossRowKinds() throws {
        // §1 presentation contract: every row kind emits the SAME ordered trailing
        // column set, which is exactly what keeps the Enabled toggle collinear.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        model.credentialProfiles = try JSONDecoder().decode([CredentialProfileEntry].self, from: Data("""
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """.utf8))
        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        let profile = try #require(rows.first { $0.isProfile })
        #expect(AccountsPresentation.columns(for: cli) == AccountsPresentation.columns(for: profile))
        #expect(AccountsPresentation.columns(for: cli) == [.enabled, .manage, .delete])
    }

    @MainActor
    @Test func composerAccountSegmentKeepsAutomaticStableAndShowsAnExplicitPin() throws {
        // An unpinned thread is one stable Automatic choice even while the
        // server's next-up route changes; an explicit pin shows its account.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))

        // No projection yet.
        var seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "Automatic")

        // Projection: the native CLI login is next up.
        model.harnessAccounts = try JSONDecoder().decode([HarnessAccounts].self, from: Data("""
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":true,"next_up":{"kind":"native","route":"local_session"}}]
        """.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "Automatic")

        // The same unprofiled/default identity may honestly route through an
        // API key when the native source is unavailable or config requests it.
        model.harnessAccounts = try JSONDecoder().decode([HarnessAccounts].self, from: Data("""
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":false,"next_up":{"kind":"native","route":"api_key"}}]
        """.utf8))
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.label == "Automatic")

        // A thread pin overrides the default and resolves to the profile's name.
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: "work")
        #expect(seg.pinned == true)
        #expect(seg.label == "Work")
    }

    @Test func generatedIdSlugifiesTheDisplayName() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: []) == "work")
        #expect(AccountsPresentation.generatedProfileId(displayName: "Experiment A (max)", existing: [])
            == "experiment-a-max")
        // Non-latin names fall back to the auto id instead of an invalid slug.
        #expect(AccountsPresentation.generatedProfileId(displayName: "個人アカウント", existing: []) == "acct")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: []) == "acct")
    }

    @Test func quotaDatesAreAlwaysPresentedInEnglish() {
        let value = formattedDate("2026-07-18T12:30:00.000Z")
        #expect(value?.contains("Jul") == true)
    }

    @Test func generatedIdIsUniqueAndAlwaysValid() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: ["work"]) == "work-2")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: ["acct", "acct-2"]) == "acct-3")
        // Every derivation the UI can produce passes the server's slug rule.
        for name in ["Work", "  ", "--weird__", "Ελληνικό όνομα", String(repeating: "x", count: 200)] {
            let id = AccountsPresentation.generatedProfileId(displayName: name, existing: ["acct"])
            #expect(AccountsPresentation.isValidSlug(id), "invalid slug for \(name): \(id)")
        }
    }
}
