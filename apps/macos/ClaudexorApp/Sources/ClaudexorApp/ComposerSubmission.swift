import Foundation
import SwiftUI
import ClaudexorKit

// MARK: - Composer submission lifecycle
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): user
// guidance, generation-fenced send/recovery, per-turn reset, and cancellation.

extension ThreadsScreen {
    /// Inline guidance on the controls row: the no-project gate (only Ask works
    /// without a project) or, in the draft state, where the new thread lands.
    @ViewBuilder var composerHint: some View {
        if capUsdInvalid {
            // Highest priority: a bad budget cap blocks Send — say so even with the
            // "⋯" popover closed, so the disabled Send isn't a mystery.
            Label("Budget cap must be a non-negative number (in ⋯)", systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange).lineLimit(1)
        } else if let testCommandMessage = testCommandErrorMessage {
            Label(testCommandMessage, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange).lineLimit(1)
        } else if !threadHasProject {
            Text("Pick a project to use Agent · Plan · Best-of")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                .help("Without a project, only Ask (read-only) is available")
        } else if model.selectedThreadId == nil {
            Text("New thread on \(URL(fileURLWithPath: model.normalizedProjectRoot).lastPathComponent)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// A disabled native button is skipped by keyboard focus, so its single
    /// causal reason also remains reachable as adjacent semantic text.
    @ViewBuilder var composerSendReason: some View {
        if !model.selectedThreadBusy,
           !model.selectedThreadStarting,
           let reason = composerSendAvailability.disabledReason {
            Label(
                reason,
                systemImage: composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "text.cursor" : "exclamationmark.triangle.fill"
            )
            .font(.caption2)
            .foregroundStyle(
                composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? Color.secondary : Theme.status(.caution)
            )
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The composer is ALWAYS live: with no thread selected, the first message
    /// materializes one (on the Current Project). No silent no-op (the v0.9 bug).
    /// The text is cleared only after a successful send, restored on failure.
    func send() {
        // While the head turn is still running, ⌘↩ / Return submits through
        // GlassField.onSubmit must not queue a second turn over a live one — route
        // the keystroke to Stop instead (mirrors the swapped button).
        if model.selectedThreadBusy { stop(); return }
        let attemptedDraft = composerDraftSnapshot
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        // The button and the direct Return/Command-Return path consume the exact
        // same availability value, including the empty-message reason.
        guard composerSendAvailability.enabled else {
            if composerAttachmentsInvalid {
                model.threadStatus = composerAttachmentAdmission.message
            }
            return
        }
        // Resolve the composer's intent + strategy knobs (D24/D31/D32) into the
        // effective wire mode + delegate/council/until-clean facts.
        let resolution = resolveComposerStrategy(
            intent: composerMode, agentStrategy: agentStrategy,
            delegate: DelegationPresentation.requestedForWire(
                isOn: delegate, control: delegateControlState),
            councilEnabled: councilEnabled, councilMembers: councilMembers)
        let mode = resolution.mode
        var options = currentOptions
        options.untilClean = resolution.untilClean
        options.delegate = resolution.delegate
        options.council = resolution.council
        options.councilN = resolution.councilN
        let chosenModel = primaryFamily.flatMap { composerModels[$0.rawValue] } ?? ""
        let atts = composerAttachments
        let materializingFirstTurn = model.selectedThreadId == nil
        let submission = composerSubmissions.begin(from: composerSelectionContext)
        composerText = ""
        composerAttachments = []
        Task {
            let sent = await model.composerSend(
                prompt: text,
                mode: mode,
                model: chosenModel,
                attachments: atts,
                options: options,
                onMaterializedThread: { threadID in
                    composerSubmissions.registerMaterializedThread(
                        threadID,
                        for: submission,
                        current: composerSelectionContext
                    )
                },
                completionIsRelevant: {
                    composerSubmissions.ownsCompletion(
                        submission, current: composerSelectionContext
                    )
                }
            )
            let ownsCompletion = composerSubmissions.ownsCompletion(
                submission, current: composerSelectionContext
            )
            defer { composerSubmissions.finish(submission) }
            guard ownsCompletion else { return }
            let current = composerDraftSnapshot
            if sent, materializingFirstTurn {
                let modelsWereUnchanged = current.composerModels == attemptedDraft.composerModels
                applyComposerDraftSnapshot(
                    ComposerDraftRecovery.afterSuccessfulSend(
                        attempted: attemptedDraft,
                        current: current,
                        defaults: perTurnComposerDefaults
                    )
                )
                if modelsWereUnchanged { poolModelCatalogs = [:] }
            } else if !sent {
                applyComposerDraftSnapshot(
                    ComposerDraftRecovery.afterFailedSend(
                        attempted: attemptedDraft,
                        current: current
                    )
                )
            }
        }
    }

    var perTurnComposerDefaults: ComposerDraftSnapshot {
        .init(
            text: composerText,
            attachments: composerAttachments,
            mode: composerMode,
            selectedAccess: model.effectiveThreadAccess.flatMap(AccessProfile.init(wire:))
                ?? model.composerAccessDefault
        )
    }

    func resetPerTurnComposerOptions() {
        // Explicit switches reset non-sticky knobs. First-turn materialization
        // uses the field-wise completion merge instead, so next-message edits
        // made during the await survive. Access seeds from selected authority,
        // never Browser's effective override.
        capUsdText = ""
        selectedWebPolicy = "auto"
        authRoutePreference = ""
        effortPreference = ""
        selectedAccess = model.effectiveThreadAccess.flatMap(AccessProfile.init(wire:))
            ?? model.composerAccessDefault
        maxAttempts = 3
        showOptions = false
        browser = false
        agentStrategy = .single
        delegate = false
        councilEnabled = false
        councilMembers = 2
        reviewDraft = .init()
        testCommandText = ""
        composerModels = [:]
        poolModelCatalogs = [:]
    }

    var composerDraftSnapshot: ComposerDraftSnapshot {
        .init(
            text: composerText,
            attachments: composerAttachments,
            mode: composerMode,
            capUsdText: capUsdText,
            selectedAccess: selectedAccess,
            selectedWebPolicy: selectedWebPolicy,
            authRoutePreference: authRoutePreference,
            effortPreference: effortPreference,
            maxAttempts: maxAttempts,
            agentStrategy: agentStrategy,
            delegate: delegate,
            councilEnabled: councilEnabled,
            councilMembers: councilMembers,
            browser: browser,
            reviewDraft: reviewDraft,
            testCommandText: testCommandText,
            composerModels: composerModels
        )
    }

    func applyComposerDraftSnapshot(_ draft: ComposerDraftSnapshot) {
        composerText = draft.text
        composerAttachments = draft.attachments
        composerMode = draft.mode
        capUsdText = draft.capUsdText
        selectedAccess = draft.selectedAccess
        selectedWebPolicy = draft.selectedWebPolicy
        authRoutePreference = draft.authRoutePreference
        effortPreference = draft.effortPreference
        maxAttempts = draft.maxAttempts
        agentStrategy = draft.agentStrategy
        delegate = draft.delegate
        councilEnabled = draft.councilEnabled
        councilMembers = draft.councilMembers
        browser = draft.browser
        reviewDraft = draft.reviewDraft
        testCommandText = draft.testCommandText
        composerModels = draft.composerModels
    }

    /// Cancel the selected thread's active head run (server-owned cancel via
    /// /runs/:id/control). Fires whenever the composer is in the cancellable
    /// `.busy` state — including the bound-but-not-yet-hydrated window, where the
    /// runId (`selectedHeadRunId`) is a valid cancel target even before the live
    /// `TaskRun` row merges. No-op while `.starting` (no runId) or `.idle`.
    func stop() {
        // Fire whenever the composer is SHOWING Stop (busy and not the no-target
        // "Starting…" state) and a cancel target exists — including the detail-load
        // window, where busy/headRunId come from the thread-summary head run.
        guard !stopping, model.selectedThreadBusy, !model.selectedThreadStarting,
              let runId = model.selectedHeadRunId else { return }
        stopping = true
        Task {
            // defer: the button must re-enable on EVERY exit (incl. task
            // cancellation mid-await), never park as "Stopping...".
            defer { stopping = false }
            await model.cancel(runId)
        }
    }
}
