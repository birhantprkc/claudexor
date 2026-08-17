import Foundation
import ClaudexorKit

/// PURE state mapping for the AuthSheet (W4.8 V21a): ONE primary CTA derived
/// from the cause, and ONE merged human status line per setup job — never
/// contradictory combos like "Failed + Completed + exit 0". Unit-tested.
enum AuthSheetPresentation {
    struct SetupTarget: Equatable {
        let profileId: String?
        let differsFromRequested: Bool
    }

    /// A sheet selects the target for a fresh login. Once a server-owned job is
    /// present, every continuation follows that job's exact target, including
    /// nil (the default store); nil must never fall back to the sheet profile.
    static func setupTarget(requestedProfileId: String?, job: SetupJob?) -> SetupTarget {
        guard let job else {
            return SetupTarget(profileId: requestedProfileId, differsFromRequested: false)
        }
        return SetupTarget(
            profileId: job.profileId,
            differsFromRequested: job.profileId != requestedProfileId)
    }

    /// Auto-start is safe only after recovery positively proves that no active
    /// setup job exists. A nil job paired with streamLost is unknown state, not
    /// permission to create a possible duplicate.
    static func shouldAutoStartLogin(
        requested: Bool,
        consumed: Bool,
        lifecycle: SetupLifecycleSnapshot,
        targetVerified: Bool
    ) -> Bool {
        requested && !consumed && lifecycle.connection == .idle
            && lifecycle.job == nil && !targetVerified
    }

    static func showsGlobalApiKeyPanel(profileId: String?, secretName: String?) -> Bool {
        profileId == nil && secretName != nil
    }

    /// The managed secret-store slot a family's auth sheet writes — the EXACT
    /// engine grammar (packages/util/src/secret-names.ts); nil = no API-key
    /// fallback for the family (no panel, no Store-key CTA). Extracted from
    /// the view (#132 R1) so the mapping is unit-pinned: a view-only revert of
    /// AuthSheet.swift can no longer silently drop a family's slot while the
    /// whole suite stays green.
    static func managedSecretSlot(for family: HarnessFamily) -> String? {
        switch family {
        case .codex: "openai"; case .claude: "anthropic"; case .cursor: "cursor"
        case .opencode: "opencode"; case .raw: "raw"; case .openrouter: "openrouter"
        default: nil
        }
    }

    /// The ONE presentational owner of the Store-key action's availability
    /// (issue #132 class fix, INV-134): the inner panel button AND the footer
    /// "Store key" CTA both derive disabled + hover from THIS projection, so
    /// an unavailable store is a visibly disabled control that explains its
    /// real cause — never a silent no-op click. Causes rank by severity:
    /// an offline engine makes busy/empty moot; busy outranks the empty field.
    struct StoreKeyAvailability: Equatable {
        enum BlockedReason: Equatable {
            case gatewayOffline
            case actionInFlight
            case emptyKeyField

            /// Cause-specific hover text — it must never claim "empty field"
            /// while the real blocker is the engine connection.
            var help: String {
                switch self {
                case .gatewayOffline: return "Engine offline: reconnect before storing a key."
                case .actionInFlight: return "Wait for the current action to finish."
                case .emptyKeyField: return "Enter the API key in the fallback field first."
                }
            }
        }

        let blockedReason: BlockedReason?
        var enabled: Bool { blockedReason == nil }

        /// Hover help for the panel's Store Key button: the blocking cause
        /// while disabled, else the plain action description.
        var panelHelp: String {
            blockedReason?.help
                ?? "Store this fallback API key, then refresh exactly that credential source."
        }

        /// Whitespace-only input counts as empty — the store guard trims the
        /// field before writing, so an untrimmed "enabled" would be a lie.
        init(gatewayAvailable: Bool, actionInFlight: Bool, keyField: String) {
            if !gatewayAvailable {
                blockedReason = .gatewayOffline
            } else if actionInFlight {
                blockedReason = .actionInFlight
            } else if keyField.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blockedReason = .emptyKeyField
            } else {
                blockedReason = nil
            }
        }
    }

    /// The `oauth_url_input` paste field's Submit availability (INV-134): a
    /// disabled control names its real cause, and a LAPSED vendor sign-in window
    /// is never a "type it again" state — the only act that works there is a
    /// fresh link, so Submit stays off and says so.
    struct SignInCodeAvailability: Equatable {
        enum BlockedReason: Equatable {
            case windowLapsed
            case sending
            case emptyField

            var help: String {
                switch self {
                case .windowLapsed: return "The sign-in window closed. Get a new link first."
                case .sending: return "Delivering the code to the sign-in…"
                case .emptyField: return "Paste the code from the sign-in page first."
                }
            }
        }

        let blockedReason: BlockedReason?
        var enabled: Bool { blockedReason == nil }

        /// Hover help for Submit: the blocking cause while disabled, else the
        /// plain action description.
        var help: String {
            blockedReason?.help ?? "Deliver this one-time code to the waiting sign-in."
        }

        /// Whitespace-only input counts as empty — the card trims before
        /// submitting, so an untrimmed "enabled" would be a lie.
        init(windowLapsed: Bool, sending: Bool, codeField: String) {
            if windowLapsed {
                blockedReason = .windowLapsed
            } else if sending {
                blockedReason = .sending
            } else if codeField.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blockedReason = .emptyField
            } else {
                blockedReason = nil
            }
        }
    }

    /// Whether the sign-in deadline passing may LAPSE the card (and, per the
    /// auto-re-issue decision, replace the link). Auto-re-issue exists for a
    /// window that closed with nothing delivered; firing it once a code is on
    /// its way cancels the vendor mid token-exchange and burns the one-time
    /// code, so a delivered — or still-sending — value outranks the clock.
    static func deadlineMayLapse(codeDelivered: Bool, sending: Bool) -> Bool {
        !codeDelivered && !sending
    }

    /// How often the sign-in card may replace a lapsed link BY ITSELF. Л-23
    /// keeps the automatic replacement; this bounds it. The vendor's window is
    /// a hard 60 s, so ONE automatic link buys a full second window for exactly
    /// the case auto-re-issue exists for — a consent screen that ran slightly
    /// long. Past that the presses are unattended: an uncapped card hands a user
    /// who walked away a fresh DETACHED vendor login every minute, and each new
    /// link silently invalidates the code the previous one is still showing, so
    /// they come back to a clean-looking field belonging to a cancelled job.
    ///
    /// The budget lives on the SHEET, not the card: every re-issue creates a new
    /// job, which unmounts and rebuilds the card, so card-local state could
    /// never count past one.
    struct ReissueBudget: Equatable {
        static let automaticLimit = 1
        private(set) var automatic = 0

        /// Whether an unattended replacement may still fire.
        var armed: Bool { automatic < Self.automaticLimit }

        /// A user press proves someone is watching and RE-ARMS the budget; an
        /// unattended replacement spends it.
        mutating func spend(automatic isAutomatic: Bool) {
            automatic = isAutomatic ? automatic + 1 : 0
        }
    }

    /// What a CLOSED sign-in window says. Two reachable branches, two truths:
    /// the card promises a replacement link only when it is actually issuing
    /// one. It is not, when the card mounts on an already-expired job and when
    /// the automatic budget above is spent — in both the explicit button is the
    /// only thing that still works.
    static func lapsedWindowMessage(replacing: Bool) -> String {
        let closed = "That sign-in window closed before a code arrived, and it cannot be extended. The link above is dead"
        return replacing
            ? "\(closed) — Claudexor is issuing a fresh one, and it replaces the link here as soon as it arrives."
            : "\(closed) — get a new link below to start over."
    }

    /// The ONE cause line for every control that acts on a LAPSED sign-in link.
    /// The URL is dead the moment the vendor's window closes, so Open/Copy are
    /// disabled and say this rather than silently doing nothing (INV-134).
    static let lapsedSignInLinkHelp = "This sign-in link expired. Get a new link first."

    /// VoiceOver name for the disclosed sign-in link. The label DESCRIBES the
    /// URL, never replaces it: a bare "Sign-in link" left a VoiceOver user with
    /// no way to hear the address they were about to open, and no way to tell a
    /// live link from an expired one.
    static func signInLinkLabel(url: String, lapsed: Bool) -> String {
        lapsed ? "Expired sign-in link \(url)" : "Sign-in link \(url)"
    }

    /// Whether the setup-job panel draws the deadline countdown. One fact, one
    /// owner: while the paste card is on screen the countdown belongs THERE,
    /// beside the field it governs, so the panel yields instead of rendering a
    /// second clock for the same deadline.
    static func jobPanelShowsDeadline(
        disclosureFlow: SetupLoginDisclosureFlow?, phase: SetupJobPhase
    ) -> Bool {
        !(disclosureFlow == .oauthUrlInput && phase == .awaitingUser)
    }

    /// What the login-disclosure card may SAY and OFFER. The card is not
    /// codex-only — a terminal-mode claude/cursor login discloses its captured
    /// `oauth_url` through the same overlay — so both answers come from the
    /// harness the JOB is for, never from a hardcoded vendor.
    struct LoginDisclosureCard: Equatable {
        /// Shared `HarnessFamily` vocabulary; falls back to the harness id
        /// rather than inventing prose for a family with no label.
        let vendor: String
        /// The browser-callback opt-in is a codex app-server flow selector
        /// (`SetupCodexLoginFlow`). Elsewhere there is nothing to switch to,
        /// and the card hides it — an action that cannot work is not a thing
        /// to explain.
        let offersBrowserCallback: Bool
    }

    static func loginDisclosureCard(harness: SetupHarness) -> LoginDisclosureCard {
        LoginDisclosureCard(
            vendor: HarnessFamily(rawValue: harness.rawValue).label,
            offersBrowserCallback: harness == .codex)
    }

    /// Hover help for the native-setup panel's Log in / Manage Login button.
    /// It names NO Terminal: every login this sheet starts uses the `daemon`
    /// transport, and every daemon-hosted mode (device_code, url_disclosure,
    /// url_disclosure_with_input) is hosted in this card by construction —
    /// packages/cli/src/setup-jobs.ts, "Daemon-hosted modes never touch
    /// Terminal". The old text special-cased codex and promised the other
    /// families a Terminal window that has not opened since the 2026-08-04
    /// owner directive; a per-family branch here would only be a second guess
    /// at a server-owned fact, so the sentence stays true for all of them.
    static func nativeLoginHelp(family: HarnessFamily, verified: Bool) -> String {
        verified
            ? "Open the native \(family.label) login flow to manage the verified session."
            : "Start the native \(family.label) sign-in — the link and any one-time code appear here in this sheet, with no Terminal window."
    }

    /// The Recheck / reconnect outcome sentence. A family with no default
    /// credential store never runs a source-targeted probe, so it must neither
    /// claim one completed nor blame the engine for one that never started;
    /// what it really refreshed is its accounts projection, and it says so.
    static func recheckStatus(
        family: HarnessFamily,
        profileId: String?,
        job: SetupJob?,
        succeeded: Bool
    ) -> String {
        let noDefaultStore = profileId == nil && family.authReadinessRequest(after: job) == nil
        guard succeeded else {
            return noDefaultStore
                ? "Could not refresh the \(family.label) accounts. Reconnect the engine and try again."
                : "Exact auth-readiness check failed for \(family.label). Reconnect the engine and try again."
        }
        if noDefaultStore {
            return "\(family.label) keeps no default login store, so there is nothing to probe — its accounts were refreshed instead."
        }
        return profileId == nil
            ? "Exact auth-readiness check completed for \(family.label)."
            : "Account readiness refreshed for this \(family.label) profile."
    }

    /// D-17 audit point 8: the codex device-code `not_supported` terminal state
    /// is NOT a dead-end message. It offers a first-class native action.
    enum DeviceAuthFallback: Equatable {
        /// Start the legacy Terminal localhost-callback (browser_redirect) login.
        case terminalLogin
    }

    /// When a codex device-code login terminalizes as `not_supported` because the
    /// installed app-server lacks the typed auth methods, the daemon carries the
    /// consistent typed code `device_auth_unsupported` on the native-command
    /// receipt (the SAME code the runner result, journal, control DTO, and Swift
    /// surface all use). That state exposes a real transition — start the legacy
    /// Terminal (browser_redirect) sign-in — never merely a CLI instruction.
    static func deviceAuthFallback(job: SetupJob) -> DeviceAuthFallback? {
        guard job.harness == .codex,
              job.state == .notSupported,
              job.nativeCommand?.errorCode == .deviceAuthUnsupported else { return nil }
        return .terminalLogin
    }

    enum PrimaryCTA: Equatable {
        /// Start the native login flow (no verified session yet).
        case login
        /// Re-run the doctor probe/smoke (credentials present but unproven).
        case retryProbe
        /// Store an API key (no native support path and no key yet).
        case storeKey
        /// Re-establish setup truth (stream lost / unconfirmed termination).
        case reconnect
        /// Nothing to fix — the sheet's only primary act is closing it.
        case done

        var label: String {
            switch self {
            case .login: return "Log in"
            case .retryProbe: return "Retry check"
            case .storeKey: return "Store key"
            case .reconnect: return "Reconnect"
            case .done: return "Done"
            }
        }
    }

    /// The one primary action, by cause. Order is severity: unknown process
    /// state must resolve first; an ACTIVE job means we are already doing the
    /// primary thing (observe it — closing is the only primary act); then the
    /// readiness ladder.
    static func primaryCTA(
        healthOk: Bool,
        nativeSupported: Bool,
        nativeReady: Bool,
        keyStored: Bool,
        streamLost: Bool,
        jobActive: Bool,
        blocksReplacement: Bool
    ) -> PrimaryCTA {
        if streamLost || blocksReplacement { return .reconnect }
        if jobActive { return .done }
        if healthOk { return .done }
        // Native path: the cause is the session — log in, or re-probe a
        // verified-but-degraded one. Storing a key belongs to the NON-native
        // path only: a missing fallback key is normalized as `skip`, never
        // evidence that the key caused the degraded state (F4 triad sol #1).
        if nativeSupported { return nativeReady ? .retryProbe : .login }
        return keyStored ? .retryProbe : .storeKey
    }

    /// ONE human status for a setup job: the phase while it lives, a single
    /// reconciled phrase once terminal (state and outcome never both shout).
    static func jobStatusLine(
        state: SetupJobState,
        phase: SetupJobPhase,
        outcomeReason: String?,
        exitCode: Int?
    ) -> String {
        switch state {
        case .queued: return "Queued"
        case .running, .waitingForInput:
            switch phase {
            case .launching: return "Launching the native login…"
            case .awaitingUser: return "Waiting for you to finish the login"
            case .verifying: return "Verifying the session…"
            case .cancelling: return "Cancelling…"
            default: return "Working…"
            }
        case .succeeded:
            return "Login verified"
        case .cancelled:
            return "Cancelled"
        case .timedOut:
            return "Timed out waiting for the login"
        case .notSupported:
            return "Not supported for this harness"
        case .failed, .interruptedUnknown:
            // The single honest failure phrase: the typed reason when it says
            // more than "error"; the exit code only when it IS the evidence.
            if let reason = outcomeReason, reason == "termination_unconfirmed" {
                return "Process termination is unconfirmed"
            }
            if let code = exitCode, code != 0 { return "Failed (exit \(code))" }
            if let reason = outcomeReason, !reason.isEmpty, reason != "completed" {
                return "Failed (\(reason.replacingOccurrences(of: "_", with: " ")))"
            }
            return state == .failed ? "Failed" : "Interrupted — state unknown"
        }
    }
}

extension AuthSheetPresentation.PrimaryCTA {
    /// INV-134: a disabled control explains why — the DISABLING cause wins
    /// over the plain action description.
    func help(family: String, busy: Bool = false, loginBlocked: Bool = false,
              storeKeyBlocked: AuthSheetPresentation.StoreKeyAvailability.BlockedReason? = nil)
        -> String
    {
        // The store-key projection carries its own severity order (offline
        // beats busy beats empty), so its cause wins the merged ladder here.
        if self == .storeKey, let cause = storeKeyBlocked { return cause.help }
        if busy { return "Wait for the current action to finish." }
        if loginBlocked, self == .login {
            return "Login is unavailable until setup state resolves (an active job, recovery, or an unconfirmed prior process)."
        }
        return help(family: family)
    }

    func help(family: String) -> String {
        switch self {
        case .login: return "Start the native \(family) login flow."
        case .retryProbe: return "Run a fresh, non-cached Harness Doctor probe."
        case .storeKey: return "Store the API key entered in the fallback field below."
        case .reconnect: return "Re-establish setup truth (re-snapshot the job / prove the process gone)."
        case .done: return "Close this auth sheet."
        }
    }
}

/// Whether closing the AuthSheet needs a confirmation — pure, so the "silently
/// abandoned a live login" cases stay unit-pinned. (Lives beside the sheet's
/// other pure mappers rather than in the view file.)
enum AuthSheetClosePolicy {
    static func requiresConfirmation(job: SetupJob?, connection: SetupLifecycleConnection,
                                     actionInFlight: Bool) -> Bool {
        if actionInFlight { return true }
        if job?.isActive == true || job?.blocksReplacement == true { return true }
        return connection == .recovering || connection == .reconnecting || connection == .streamLost
    }
}
