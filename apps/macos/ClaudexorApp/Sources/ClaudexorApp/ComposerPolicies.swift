import Foundation
import ClaudexorKit

// MARK: - Browser selected/effective state

struct ComposerBrowserPolicy: Equatable {
    var selectedAccess: AccessProfile
    var selectedWebPolicy: String
    var browserArmed: Bool
    var browserAvailable: Bool = true

    var effectiveBrowserArmed: Bool { browserArmed && browserAvailable }
    var effectiveAccess: AccessProfile { effectiveBrowserArmed ? .full : selectedAccess }
    var effectiveWebPolicy: String {
        effectiveBrowserArmed && selectedWebPolicy == "off" ? "auto" : selectedWebPolicy
    }

    func disarmingBrowser() -> ComposerBrowserPolicy {
        var copy = self
        copy.browserArmed = false
        return copy
    }

    static func browserArmed(_ current: Bool, afterSelecting mode: RunMode) -> Bool {
        current && !mode.isReadOnly
    }

    static func browserArmed(_ current: Bool, afterAvailability available: Bool) -> Bool {
        current && available
    }
}

// MARK: - Canonical run-control applicability projection

struct ComposerRunControlApplicability: Equatable {
    struct Control: Equatable {
        var applicable: Bool
        var reason: String?
    }

    var reviewers: Control
    var protectedPathApprovals: Control

    static func resolve(mode: RunMode) -> ComposerRunControlApplicability {
        let isAgent = mode == .agent || mode == .bestOfN || mode == .create
        return .init(
            reviewers: isAgent
                ? .init(applicable: true)
                : .init(
                    applicable: false,
                    reason: "Reviewer controls only apply to Agent runs; Council is the Plan critique path."
                ),
            protectedPathApprovals: isAgent
                ? .init(applicable: true)
                : .init(
                    applicable: false,
                    reason: "Protected-path approvals only apply to Agent runs; Ask and Plan are read-only."
                )
        )
    }
}

// MARK: - Send availability

enum ComposerSendBlocker: Equatable {
    case budget(String)
    case reviewer(String)
    case approvals(String)
    case testCommand(String)
    case attachments(String)

    var reason: String {
        switch self {
        case .budget(let value), .reviewer(let value), .approvals(let value),
             .testCommand(let value), .attachments(let value):
            return value
        }
    }
}

struct ComposerSendAvailability: Equatable {
    var enabled: Bool
    var name: String
    var help: String
    var disabledReason: String?

    static func resolve(
        message: String,
        blockers: [ComposerSendBlocker]
    ) -> ComposerSendAvailability {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = trimmed.isEmpty ? "Type a message to send" : blockers.first?.reason
        if let reason {
            return .init(enabled: false, name: "Send", help: reason, disabledReason: reason)
        }
        return .init(
            enabled: true,
            name: "Send",
            help: "Send (Command-Return)",
            disabledReason: nil
        )
    }
}

// MARK: - Complete first-turn correction draft

struct ComposerDraftSnapshot: Equatable {
    var text: String = ""
    var attachments: [PendingAttachment] = []
    var mode: RunMode = .agent
    var capUsdText: String = ""
    var selectedAccess: AccessProfile = .workspaceWrite
    var selectedWebPolicy: String = "auto"
    var authRoutePreference: String = ""
    var effortPreference: String = ""
    var maxAttempts: Int = 3
    var agentStrategy: AgentStrategy = .single
    var delegate: Bool = false
    var councilEnabled: Bool = false
    var councilMembers: Int = 2
    var browser: Bool = false
    var reviewDraft: ComposerReviewDraft = .init()
    var testCommandText: String = ""
    var composerModels: [String: String] = [:]
}

enum ComposerDraftRecovery {
    static func afterFailedSend(
        attempted: ComposerDraftSnapshot,
        current: ComposerDraftSnapshot
    ) -> ComposerDraftSnapshot {
        guard current.text.isEmpty else { return current }
        var recovered = current
        recovered.text = attempted.text
        let attemptedIDs = Set(attempted.attachments.map(\.id))
        recovered.attachments = attempted.attachments
            + current.attachments.filter { !attemptedIDs.contains($0.id) }
        return recovered
    }

    /// A successful first send consumes the attempted per-turn options, but it
    /// must not consume choices the user already made for the next message while
    /// the request was awaiting the engine. Reset each field only when it still
    /// equals the submitted value; text, attachments, and intent always belong to
    /// the live composer and are preserved.
    static func afterSuccessfulSend(
        attempted: ComposerDraftSnapshot,
        current: ComposerDraftSnapshot,
        defaults: ComposerDraftSnapshot
    ) -> ComposerDraftSnapshot {
        var recovered = current
        recovered.capUsdText = sameBudget(current.capUsdText, attempted.capUsdText)
            ? defaults.capUsdText : current.capUsdText
        recovered.selectedAccess = current.selectedAccess == attempted.selectedAccess
            ? defaults.selectedAccess : current.selectedAccess
        recovered.selectedWebPolicy = current.selectedWebPolicy == attempted.selectedWebPolicy
            ? defaults.selectedWebPolicy : current.selectedWebPolicy
        recovered.authRoutePreference = current.authRoutePreference == attempted.authRoutePreference
            ? defaults.authRoutePreference : current.authRoutePreference
        recovered.effortPreference = current.effortPreference == attempted.effortPreference
            ? defaults.effortPreference : current.effortPreference
        recovered.maxAttempts = current.maxAttempts == attempted.maxAttempts
            ? defaults.maxAttempts : current.maxAttempts
        recovered.agentStrategy = current.agentStrategy == attempted.agentStrategy
            ? defaults.agentStrategy : current.agentStrategy
        recovered.delegate = current.delegate == attempted.delegate
            ? defaults.delegate : current.delegate
        recovered.councilEnabled = current.councilEnabled == attempted.councilEnabled
            ? defaults.councilEnabled : current.councilEnabled
        recovered.councilMembers = current.councilMembers == attempted.councilMembers
            ? defaults.councilMembers : current.councilMembers
        recovered.browser = current.browser == attempted.browser
            ? defaults.browser : current.browser
        recovered.reviewDraft = current.reviewDraft == attempted.reviewDraft
            ? defaults.reviewDraft : current.reviewDraft
        recovered.testCommandText = sameTestCommand(
            current.testCommandText, attempted.testCommandText
        )
            ? defaults.testCommandText : current.testCommandText
        recovered.composerModels = normalizedModels(current.composerModels)
            == normalizedModels(attempted.composerModels)
            ? defaults.composerModels : current.composerModels
        return recovered
    }

    private static func sameBudget(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = rhs.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty || right.isEmpty { return left.isEmpty && right.isEmpty }
        guard let leftValue = ComposerOptionParser.parseNonnegativeFiniteDouble(left),
              let rightValue = ComposerOptionParser.parseNonnegativeFiniteDouble(right)
        else { return left == right }
        return leftValue == rightValue
    }

    private static func sameTestCommand(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = rhs.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty || right.isEmpty { return left.isEmpty && right.isEmpty }
        do {
            return try ComposerOptionParser.parseCommandArgvStrict(left)
                == ComposerOptionParser.parseCommandArgvStrict(right)
        } catch {
            return left == right
        }
    }

    private static func normalizedModels(_ models: [String: String]) -> [String: String] {
        models.compactMapValues { value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }
}

struct ComposerSelectionContext: Equatable {
    var locationID: String
    var threadID: String?
    var repoRoot: String
}

enum ComposerSelectionTransition: Equatable {
    case internalMaterialization
    case sameSelection
    case explicitSelection
}

/// Identity captured at submission time. The token binds an async completion to
/// one exact composer generation; a later selection can never restore or reset a
/// different thread's draft.
struct ComposerSubmissionToken: Equatable {
    fileprivate var id: UInt64
    fileprivate var selectionGeneration: UInt64
    fileprivate var origin: ComposerSelectionContext
}

/// Single owner for draft→thread materialization and async send completion.
/// `materializedThreadID` is registered by the create response before AppModel
/// selects it, so same-repository user selections are not inferred as internal.
struct ComposerSubmissionCoordinator: Equatable {
    private struct ActiveSubmission: Equatable {
        var token: ComposerSubmissionToken
        var materializedThreadID: String?
    }

    private var nextID: UInt64 = 0
    private var selectionGeneration: UInt64 = 0
    private var active: ActiveSubmission?

    mutating func begin(from origin: ComposerSelectionContext) -> ComposerSubmissionToken {
        nextID &+= 1
        let token = ComposerSubmissionToken(
            id: nextID,
            selectionGeneration: selectionGeneration,
            origin: origin
        )
        active = .init(token: token, materializedThreadID: nil)
        return token
    }

    /// Returns whether the newly created thread may become the selection. A user
    /// selection that raced ahead invalidates the generation and keeps ownership.
    mutating func registerMaterializedThread(
        _ threadID: String,
        for token: ComposerSubmissionToken,
        current: ComposerSelectionContext
    ) -> Bool {
        guard current == token.origin,
              selectionGeneration == token.selectionGeneration,
              active?.token == token
        else { return false }
        active?.materializedThreadID = threadID
        return true
    }

    mutating func classifySelection(
        from old: ComposerSelectionContext,
        to new: ComposerSelectionContext
    ) -> ComposerSelectionTransition {
        if old.threadID != nil,
           old.locationID == new.locationID,
           old.threadID == new.threadID {
            return .sameSelection
        }
        if let active,
           active.token.selectionGeneration == selectionGeneration,
           active.token.origin == old,
           active.token.origin.threadID == nil,
           let materializedThreadID = active.materializedThreadID,
           materializedThreadID == new.threadID,
           new.locationID == active.token.origin.locationID {
            return .internalMaterialization
        }
        selectionGeneration &+= 1
        return .explicitSelection
    }

    func ownsCompletion(
        _ token: ComposerSubmissionToken,
        current: ComposerSelectionContext
    ) -> Bool {
        guard selectionGeneration == token.selectionGeneration,
              let active,
              active.token == token
        else { return false }
        if let threadID = active.materializedThreadID {
            return current.threadID == threadID
                && current.locationID == token.origin.locationID
        }
        if token.origin.threadID != nil {
            return current.threadID == token.origin.threadID
                && current.locationID == token.origin.locationID
        }
        return current == token.origin
    }

    mutating func finish(_ token: ComposerSubmissionToken) {
        if active?.token == token { active = nil }
    }
}

/// A late create/send completion may publish status only while its submission
/// still owns the visible composer. Keep the merge pure so both failure text
/// and success clearing use the same ownership rule.
enum ComposerCompletionStatus {
    static func resolving(
        current: String?,
        completion: String?,
        ownsCompletion: Bool
    ) -> String? {
        ownsCompletion ? completion : current
    }
}
