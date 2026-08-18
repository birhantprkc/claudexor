import SwiftUI
import ClaudexorKit
import Foundation

// MARK: - Accounts presentation models (INV-135)
//
// The row model + pure assembly behind the accounts surface, extracted from
// AccountsPopover.swift (readability ratchet). The views live in
// AccountsPopover.swift; the SSOT projection lives here.

/// Readiness verdict for one account row (the worst wins for the trigger dot).
enum AccountReadiness: Int, Comparable {
    case unavailable = 0, unknown = 1, ready = 2
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    var color: Color {
        switch self {
        case .ready: return Theme.status(.positive)
        case .unknown: return Theme.status(.caution)
        case .unavailable: return Theme.status(.negative)
        }
    }
}

/// One row in the accounts popover — a registered profile or a default login.
struct AccountRowModel: Identifiable {
    let id: String
    let displayName: String
    let harnessId: String
    let family: HarnessFamily
    let readiness: AccountReadiness
    let verified: Bool
    /// nil => the engine-default login for `family` (the "CLI login" row); else
    /// the credential profile.
    let profileId: String?
    let detail: String?
    let quotaGroups: [QuotaPresentation.Group]
    /// D25 Enabled: participates in pickers + the auto-rotation pool. For a
    /// profile row this is the wire `profile.enabled`; for the CLI-login row it
    /// is the harness's `native_credentials_enabled` (V11b). LIVE — the toggle
    /// PATCHes the owning surface (profile route / harness settings). This is the
    /// ONLY routing control (the F1 engine cut deleted user-settable Active).
    let enabled: Bool
    /// Server-computed NEXT-UP (F1 engine `next_up`): true when an unpinned run of
    /// this harness would route to THIS row next. INFORMATIONAL only — rendered
    /// as a quiet "Next up" badge, never a control. false when the projection is
    /// absent (older daemon) or another row is next up.
    let nextUp: Bool
    /// Non-secret {email, plan} of this account (INV-067), projected daemon-side
    /// from the owning credential-profile probe or native CLI status receipt.
    /// When present it drives the row's secondary line (`identityLine`); nil
    /// when the source does not disclose identity or an older daemon omits it.
    var identity: AccountIdentity? = nil
    var isProfile: Bool { profileId != nil }

    /// The row's identity line: "email · plan", or whichever single field the
    /// daemon disclosed. nil falls back to the readiness detail.
    var identityLine: String? {
        let parts = [identity?.email, identity?.plan]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    var secondaryLines: [String] {
        let visibleDetail = identityLine == nil || !verified ? detail : nil
        return [identityLine, visibleDetail]
            .compactMap { $0 }
            .reduce(into: []) { lines, value in
                if !value.isEmpty, !lines.contains(value) { lines.append(value) }
            }
    }
    /// A healthy row with identity stays compact, while its independent
    /// readiness fact remains reachable from the status marker's help text.
    var hiddenReadinessDetail: String? {
        guard verified, identityLine != nil, let detail, detail != identityLine else { return nil }
        return detail
    }
    /// The native vendor login row (not one of Claudexor's credential profiles).
    var isCliLogin: Bool { profileId == nil }

    /// The single worst usage window across the account's quota groups; drives
    /// the ONE compact quota line the popover shows per account.
    var worstWindow: QuotaPresentation.Window? {
        quotaGroups
            .flatMap(\.windows)
            .filter { ($0.appliesToModels ?? []).isEmpty }
            .max { ($0.usedRatio ?? -1) < ($1.usedRatio ?? -1) }
    }
    var worstPercent: Int? {
        worstWindow?.usedRatio.map { Int(($0 * 100).rounded()) }
    }

    /// Server-authored account-wide availability folded by QuotaPresentation.
    /// Ratios never create this state.
    var quotaAvailabilityState: String? {
        let states = quotaGroups.compactMap(\.availability?.state)
        if states.contains("exhausted") { return "exhausted" }
        if states.contains("cooldown") { return "cooldown" }
        return states.isEmpty ? nil : "available"
    }

    var quotaAvailabilityResetAt: String? {
        AccountsPresentation.earliestReset(
            quotaGroups.compactMap(\.availability?.resetsAt))
    }

    var scopedQuotaLabel: String? {
        let labels = Set(quotaGroups.flatMap(\.scopedExhaustions).map(\.scopeLabel))
        if labels.count == 1 { return labels.first }
        if !labels.isEmpty || quotaGroups.contains(where: \.hasOnlyScopedWindows) {
            return "Scoped limits"
        }
        return nil
    }
}

/// Pure assembly of account rows from the model's profile + readiness + quota
/// state, plus the trigger's worst-of aggregates.
enum AccountsPresentation {
    static let cliLoginLifecycleHelp =
        "CLI login = existing vendor sign-in; named accounts = isolated profiles used by explicit pin or opt-in quota rotation."

    /// Harnesses whose native subscription login can be isolated as an
    /// additive config-dir/HOME profile. `agy` (Antigravity) has NO default
    /// store, so every one of its accounts is a named profile registered here —
    /// which is also why it must stay out of `defaultAuthReadinessRequest`
    /// (DomainModels.swift), whose rows are the default "CLI login".
    static let configDirLoginHarnessIds = ["agy", "claude", "codex", "cursor"]

    /// The families the add-account flow may register, DERIVED from the set
    /// above so a fifth family is one entry there and nothing else. The picker
    /// and its caption both read this; hand-listing the vendors is what left
    /// Antigravity addable by the daemon and unreachable in the popover.
    static let addableFamilies: [HarnessFamily] =
        configDirLoginHarnessIds.map(HarnessFamily.init(rawValue:))

    /// The add form's initial vendor. Claude stays the common case, but the
    /// value must be a MEMBER of the derived list — a hardcoded id that leaves
    /// the set would select a row the picker no longer offers.
    static var defaultAddHarnessId: String {
        configDirLoginHarnessIds.contains(HarnessFamily.claude.rawValue)
            ? HarnessFamily.claude.rawValue
            : configDirLoginHarnessIds.first ?? ""
    }

    /// The add form's caption. Family-scoped hosts (the Harness Doctor's Manage
    /// sheet) name their one vendor; the global popover lists every addable
    /// one in the SSOT's own order, so the sentence cannot go stale.
    static func addAccountCaption(family: HarnessFamily?) -> String {
        let subject = family?.label ?? listed(addableFamilies.map(\.label))
        return "A second \(subject) subscription — one click opens the official CLI login."
    }

    /// "A", "A or B", "A, B, or C" — an Oxford list, so a two-family future
    /// does not read "A, or B".
    static func listed(_ labels: [String]) -> String {
        switch labels.count {
        case 0: return ""
        case 1: return labels[0]
        case 2: return "\(labels[0]) or \(labels[1])"
        default: return labels.dropLast().joined(separator: ", ") + ", or \(labels[labels.count - 1])"
        }
    }

    /// Whether a login may target the ENGINE-DEFAULT credential store — that is,
    /// whether a PROFILE-LESS login can succeed at all. `agy` has no default
    /// store, so the daemon refuses every profile-less Antigravity login; a
    /// surface that offers one must gate on THIS, never on whether the harness
    /// id happens to decode as a `SetupHarness`.
    static func supportsDefaultStoreLogin(_ family: HarnessFamily) -> Bool {
        family.defaultAuthReadinessRequest?.source == .nativeSession
    }

    /// Compare legal offset timestamps by their absolute instant. Equal
    /// instants and malformed future values use raw lexical order so the
    /// projection remains deterministic rather than depending on group order.
    static func earliestReset(_ values: [String]) -> String? {
        values.min { lhs, rhs in
            switch (try? Date(lhs, strategy: .iso8601),
                    try? Date(rhs, strategy: .iso8601)) {
            case let (left?, right?):
                return left == right ? lhs < rhs : left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return lhs < rhs
            }
        }
    }

    /// Account controls belong to the active execution location. Local daemon
    /// health is neither necessary nor sufficient while a remote host is active.
    @MainActor
    static func isAvailable(model: AppModel) -> Bool {
        model.gateway(for: model.activeExecutionLocation) != nil
    }

    @MainActor
    static func rows(model: AppModel) -> [AccountRowModel] {
        let groups = QuotaPresentation.groups(from: model.activeQuotaResponse?.snapshots ?? [])
        let accountsReadinessFresh = model.activeAccountsReadinessFresh
        var rows: [AccountRowModel] = []

        // Default logins: one per native-login family the doctor knows.
        for info in model.harnesses
        where info.family.defaultAuthReadinessRequest?.source == .nativeSession {
            let family = info.family
            let source = model.authSource(for: family, source: .nativeSession)
            // V11b per-harness accounts authority for the native/CLI-login row.
            let accounts = model.harnessAccounts(for: family.rawValue)
            // Native doctor readiness has its own harness-projection owner. A
            // failed full Accounts request must not stale a newer successful
            // Harness Doctor refresh; the Accounts projection is only the
            // fallback when no exact doctor snapshot is current.
            let exactReadinessFresh = model.activeHarnessReadinessFresh
            let nativeAvailability = exactReadinessFresh
                ? source?.availability
                : accountsReadinessFresh ? (accounts?.nativeLoginDetected == true
                    ? "available" : "unavailable") : "unknown"
            let nativeVerification = exactReadinessFresh
                ? source?.verification
                : accountsReadinessFresh && accounts != nil ? "passed" : "not_run"
            let nativeDetail: String? = if exactReadinessFresh {
                source?.detail
            } else if accountsReadinessFresh, let accounts {
                accounts.nativeLoginDetected
                    ? "CLI login detected by the cached Accounts projection."
                    : "No CLI login detected by the cached Accounts projection."
            } else {
                "Readiness is stale; refresh Accounts or Harness Doctor."
            }
            rows.append(AccountRowModel(
                id: "default/\(family.rawValue)",
                displayName: family.label,
                harnessId: family.rawValue,
                family: family,
                readiness: readiness(
                    availability: nativeAvailability,
                    verification: nativeVerification),
                verified: nativeAvailability == "available" && nativeVerification == "passed",
                profileId: nil,
                detail: nativeDetail,
                quotaGroups: groups.filter { $0.subjectId == nil && $0.harness == family.rawValue },
                // The native/CLI login's "Enabled" is the harness setting
                // `native_credentials_enabled` (V11b) — LIVE via the settings
                // PATCH surface. Absent projection => symmetrically enabled.
                enabled: accounts?.nativeCredentialsEnabled ?? true,
                nextUp: model.authoritativeNextUp(for: family.rawValue)?
                    .isDefaultRoute("local_session", legacyFallback: true) ?? false,
                identity: accounts?.identity
            ))
        }

        // Registered profiles (additive; the default login is never touched).
        for entry in model.activeCredentialProfiles {
            let availability = accountsReadinessFresh ? entry.status.availability : "unknown"
            let verification = accountsReadinessFresh ? entry.status.verification : "not_run"
            rows.append(AccountRowModel(
                id: "profile/\(entry.profile.harnessId)/\(entry.profile.profileId)",
                displayName: entry.profile.displayName,
                harnessId: entry.profile.harnessId,
                family: HarnessFamily(rawValue: entry.profile.harnessId),
                readiness: readiness(availability: availability, verification: verification),
                verified: availability == "available" && verification == "passed",
                profileId: entry.profile.profileId,
                detail: accountsReadinessFresh
                    ? entry.status.detail
                    : "Readiness is stale; refresh Accounts.",
                quotaGroups: groups.filter {
                    $0.subjectId == entry.profile.profileId && $0.harness == entry.profile.harnessId
                },
                enabled: entry.profile.enabled,
                nextUp: model.authoritativeNextUp(for: entry.profile.harnessId)?
                    .isProfile(entry.profile.profileId) ?? false,
                identity: entry.identity
            ))
        }

        return rows
    }

    private static func readiness(
        availability: String?, verification: String?
    ) -> AccountReadiness {
        if availability == "available" && verification == "passed" { return .ready }
        // `unavailable + not_run` is the canonical absent/logged-out source,
        // while `available + not_run` is a presence-only probe and stays unknown.
        if availability == "unavailable" { return .unavailable }
        if availability == nil || availability == "unknown"
            || verification == nil || verification == "not_run" || verification == "unknown" {
            return .unknown
        }
        return .unavailable
    }

    /// Worst readiness across every account — the trigger dot.
    static func worstReadiness(_ rows: [AccountRowModel]) -> AccountReadiness? {
        rows.map(\.readiness).min()
    }

    /// The composer Harness+Account chip's account segment (M9-UX item 2): what
    /// the segment shows for `harnessId` given the thread/draft's pinned profile.
    /// A pin shows one named account; otherwise the stable `Automatic` label
    /// discloses that server routing may rotate. Pure so it is unit-tested.
    struct AccountSegment: Equatable {
        /// True when the thread pins a specific account (vs. following the default).
        let pinned: Bool
        let label: String
        let systemImage: String
    }

    @MainActor
    static func composerAccountSegment(
        model: AppModel, harnessId: String, pinnedProfileId: String?
    ) -> AccountSegment {
        func profileName(_ id: String) -> String {
            model.activeCredentialProfiles.first {
                $0.profile.profileId == id && $0.profile.harnessId == harnessId
            }?.profile.displayName ?? id
        }
        if let pinned = pinnedProfileId {
            return AccountSegment(pinned: true, label: profileName(pinned), systemImage: "pin.fill")
        }
        // No pin means routing may change as quota/readiness changes. Naming the
        // transient next-up route made this one stable choice oscillate between
        // "Default", "CLI login", and "API key" during projection refreshes.
        return AccountSegment(pinned: false, label: "Automatic", systemImage: "wand.and.stars")
    }

    /// Highest used-% across every account — the trigger's quota summary.
    static func worstPercent(_ rows: [AccountRowModel]) -> Int? {
        rows.compactMap(\.worstPercent).max()
    }

    /// The trailing control columns EVERY account row emits, in order. The set is
    /// STABLE across row kinds (CLI-login vs profile) — a profile carries a real
    /// trash control where the CLI-login row reserves a clear spacer of the same
    /// width — so the Enabled toggle and Manage button stay collinear regardless
    /// of which controls a given row actually renders (owner F8 / §2.8). Pure so
    /// column-set stability is unit-tested rather than eyeballed.
    enum AccountRowColumn: String, CaseIterable, Equatable {
        case enabled, manage, delete
    }

    /// The ordered column set for a row — identical for every row kind, which is
    /// exactly what keeps the trailing controls on a shared edge.
    static func columns(for row: AccountRowModel) -> [AccountRowColumn] {
        AccountRowColumn.allCases
    }

    /// The trigger's label: a single account's name, else "N accounts".
    static func triggerTitle(_ rows: [AccountRowModel]) -> String {
        switch rows.count {
        case 0: return "Accounts"
        case 1: return rows[0].displayName
        default: return "\(rows.count) accounts"
        }
    }

    /// Derive the internal profile id the user never types (owner dogfood):
    /// slugified display name when it survives the slug rules, else "acct";
    /// numeric suffixes guarantee uniqueness against the harness's registry.
    static func generatedProfileId(displayName: String, existing: Set<String>) -> String {
        var slug = ""
        for ch in displayName.lowercased() {
            if ch == " " || ch == "." { slug.append("-") }
            else if ch.isASCII && (ch.isLowercase || ch.isNumber || ch == "-" || ch == "_") {
                slug.append(ch)
            }
        }
        while let first = slug.first, first == "-" || first == "_" { slug.removeFirst() }
        slug = String(slug.prefix(60))
        let base = isValidSlug(slug) ? slug : "acct"
        if !existing.contains(base), isValidSlug(base) { return base }
        for n in 2...999 {
            let candidate = "\(base)-\(n)"
            if !existing.contains(candidate) { return candidate }
        }
        return "\(base)-\(existing.count + 1)"
    }

    /// Client-side credential-profile slug check — `^[a-z0-9][a-z0-9_-]{0,63}$`
    /// validated WITHOUT a regex (house no-regex rule). The server re-validates.
    static func isValidSlug(_ s: String) -> Bool {
        guard (1...64).contains(s.count) else { return false }
        let head = Set("abcdefghijklmnopqrstuvwxyz0123456789")
        let tail = head.union("-_")
        guard let first = s.first, head.contains(first) else { return false }
        return s.dropFirst().allSatisfy { tail.contains($0) }
    }
}

// MARK: - Auto-switch-at-quota (batch-6 item b; tri-state since A6)
//
// The accounts-popover control maps to each eligible harness's per-harness
// `profile_limit_action` (On = `rotate`, Auto = the stored kind-aware `auto`
// default, Off = `fail`). Only harnesses that actually have a SECOND account
// can rotate, so the control targets exactly those (a config_dir_login family
// with ≥1 registered profile: the native/CLI login + ≥1 profile = 2+ rotatable
// identities). Pure so the target set and the aggregate state are unit-tested
// rather than eyeballed.
enum AccountsAutoBalance {
    /// Aggregate across the eligible harnesses. `auto` = every harness is on the
    /// stored kind-aware default; `mixed` = they disagree (rendered as "—");
    /// `unavailable` = no harness has a second account yet.
    enum State: Equatable { case on, off, auto, mixed, unavailable }

    /// The user's tri-state pick (A6): Off pins `fail`, Auto restores the stored
    /// kind-aware default (rotate for subscription subjects, fail for metered),
    /// On pins `rotate`. Raw values are the wire `profileLimitAction` strings.
    enum Choice: String, CaseIterable { case fail, auto, rotate }

    /// The rotation action is only auto-balance-capable for config_dir_login
    /// families that also have a quota/typed-limit source to trigger rotation.
    /// Cursor profiles can register (see configDirLoginHarnessIds) and — since
    /// the typed cursor vendor-limit classifier — rotate REACTIVELY under the
    /// engine's `auto` default, but cursor still has no proactive quota source,
    /// so this control's capable-set has not admitted it yet; cursor rotation
    /// stays engine-driven with no app-side knob until that is revisited.
    /// agy qualifies on the same test: `config_dir_login` profiles plus a real
    /// vendor quota source (`agy_command_usage`, read from the CLI's own
    /// `/quota`), so a control here has an observable action to drive.
    static let capableHarnessIds = ["claude", "codex", "agy"]

    /// Harnesses whose rotation has NO native identity to fall back on: their
    /// accounts are all named profiles, so one profile is one identity and
    /// there is nothing to rotate to.
    static let harnessesWithoutNativeIdentity: Set<String> = ["agy"]

    /// Harnesses eligible for the toggle: a capable family with enough
    /// identities to rotate BETWEEN — one registered profile is enough where a
    /// native login also exists, and two are needed where it does not.
    static func eligibleHarnessIds(profileHarnessIds: [String]) -> [String] {
        var counts: [String: Int] = [:]
        for id in profileHarnessIds { counts[id, default: 0] += 1 }
        return capableHarnessIds.filter { harness in
            let needed = harnessesWithoutNativeIdentity.contains(harness) ? 2 : 1
            return (counts[harness] ?? 0) >= needed
        }
    }

    /// Aggregate on/off/auto/mixed/unavailable from each eligible harness's
    /// stored action. A hand-configured `ask` counts toward Off (it is not
    /// auto-switch), matching the setter that never erases it.
    static func state(actions: [String]) -> State {
        guard !actions.isEmpty else { return .unavailable }
        if actions.allSatisfy({ $0 == "rotate" }) { return .on }
        if actions.allSatisfy({ $0 == "auto" }) { return .auto }
        if actions.allSatisfy({ $0 == "fail" || $0 == "ask" }) { return .off }
        return .mixed
    }

    /// The wire value one harness should be patched to for a pick, or nil for
    /// no-op. Off (`fail`) downgrades rotation — explicit `rotate` or the
    /// kind-aware `auto` — but never erases a hand-configured `ask`; Auto and
    /// On set their exact value everywhere (an explicit pick of a mode).
    static func patchValue(current: String, choice: Choice) -> String? {
        if current == choice.rawValue { return nil }
        if choice == .fail, current == "ask" { return nil }
        return choice.rawValue
    }
}
