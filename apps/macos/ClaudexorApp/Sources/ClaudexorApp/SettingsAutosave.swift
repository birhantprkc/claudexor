import Foundation
import ClaudexorKit

/// Global Settings autosaves at this small, explicit ownership boundary. Each
/// lane maps to exactly one partial-patch key; the two inseparable value pairs
/// (budget mode+amount and timeout mode+minutes) intentionally share a lane.
enum SettingsLane: String, CaseIterable, Hashable, Sendable {
    case routingGoal
    case paidFallback
    case primaryHarness
    case eligibleHarnesses
    case envInheritance
    case authPreference
    case paidBudget
    case interactionTimeout
}

struct SettingsLaneKey: Hashable, Sendable {
    let locationID: ExecutionLocationID
    let lane: SettingsLane
}

struct SettingsSaveTarget: Equatable, Sendable {
    let locationID: ExecutionLocationID
    let generation: Int
}

struct AdmittedSettingsEdit: Equatable, Sendable {
    let edit: GlobalSettingsEdit
    let target: SettingsSaveTarget
    let generation: Int
}

enum SettingsInteractionTimeoutDraft: Equatable, Sendable {
    case finiteMinutes(String)
    case disabled
}

enum SettingsEditValidation: Equatable, Sendable {
    case valid(SettingsUpdateRequest)
    case invalid(String)

    var isInvalid: Bool {
        if case .invalid = self { return true }
        return false
    }
}

/// One admitted user edit. Keeping the patch builder beside this enum is the
/// exact-key fence: a visible field cannot accidentally serialize hidden
/// drafts from another tab or lane.
enum GlobalSettingsEdit: Equatable, Sendable {
    case routingGoal(String, qualityTierCount: Int)
    case paidFallback(String)
    case primaryHarness(String?)
    case eligibleHarnesses([String])
    case envInheritance(String)
    case authPreference(String)
    case paidBudget(PaidBudget)
    case paidBudgetDraft(unlimited: Bool, amount: String)
    case interactionTimeout(SettingsInteractionTimeoutDraft)

    var lane: SettingsLane {
        switch self {
        case .routingGoal: .routingGoal
        case .paidFallback: .paidFallback
        case .primaryHarness: .primaryHarness
        case .eligibleHarnesses: .eligibleHarnesses
        case .envInheritance: .envInheritance
        case .authPreference: .authPreference
        case .paidBudget, .paidBudgetDraft: .paidBudget
        case .interactionTimeout: .interactionTimeout
        }
    }

    var validation: SettingsEditValidation {
        switch self {
        case .routingGoal(let goal, let tierCount):
            guard goal != "quality" || tierCount > 0 else {
                return .invalid(
                    "Quality routing needs at least one configured quality tier."
                )
            }
            return .valid(SettingsUpdateRequest(routingGoal: goal))
        case .paidFallback(let value):
            return .valid(SettingsUpdateRequest(paidFallback: value))
        case .primaryHarness(let value):
            return .valid(SettingsUpdateRequest(primaryHarness: .some(value)))
        case .eligibleHarnesses(let values):
            return .valid(SettingsUpdateRequest(eligibleHarnesses: values.sorted()))
        case .envInheritance(let value):
            return .valid(SettingsUpdateRequest(envInheritance: value))
        case .authPreference(let value):
            return .valid(SettingsUpdateRequest(authPreference: value))
        case .paidBudget(let value):
            return .valid(SettingsUpdateRequest(paidBudgetPerRun: value))
        case .paidBudgetDraft(let unlimited, let amount):
            if unlimited {
                return .valid(SettingsUpdateRequest(paidBudgetPerRun: .unlimited))
            }
            guard let value = ComposerOptionParser.parseNonnegativeFiniteDouble(amount) else {
                return .invalid("Use a non-negative USD number for a finite budget.")
            }
            return .valid(SettingsUpdateRequest(paidBudgetPerRun: .finite(maxUsd: value)))
        case .interactionTimeout(.disabled):
            return .valid(SettingsUpdateRequest(interactionTimeoutMs: .some(nil)))
        case .interactionTimeout(.finiteMinutes(let raw)):
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let minutes = Int(trimmed), minutes > 0,
                  minutes <= InteractionTimeoutContract.maxFiniteMilliseconds / 60_000
            else {
                return .invalid("Use a positive whole number of minutes.")
            }
            let (milliseconds, overflow) = minutes.multipliedReportingOverflow(by: 60_000)
            guard !overflow else {
                return .invalid("The timeout is too large.")
            }
            return .valid(SettingsUpdateRequest(interactionTimeoutMs: .some(milliseconds)))
        }
    }
}

/// Per-harness autosave lanes. Model and effort share one lane because the
/// daemon validates their merged pair atomically; every other visible control
/// owns exactly one nested HarnessSettingsPatch key.
enum HarnessSettingsLane: String, CaseIterable, Hashable, Sendable {
    case enabled
    case modelAndEffort
    case web
    case toolsAllow
    case toolsDeny
    case fallbackModel
}

struct HarnessSettingsScopeKey: Hashable, Sendable {
    let locationID: ExecutionLocationID
    let harnessID: String
}

struct HarnessSettingsLaneKey: Hashable, Sendable {
    let locationID: ExecutionLocationID
    let harnessID: String
    let lane: HarnessSettingsLane

    init(scope: HarnessSettingsScopeKey, lane: HarnessSettingsLane) {
        locationID = scope.locationID
        harnessID = scope.harnessID
        self.lane = lane
    }
}

enum HarnessSettingsEdit: Equatable, Sendable {
    case enabled(Bool)
    case modelAndEffort(modelDraft: String, effort: String, modelEditable: Bool)
    case web(String)
    case toolsAllow(String)
    case toolsDeny(String)
    case fallbackModel(String)

    func validation(harnessID: String) -> SettingsEditValidation {
        let patch: HarnessSettingsPatch
        switch self {
        case .enabled(let value):
            patch = HarnessSettingsPatch(enabled: value)
        case .modelAndEffort(let modelDraft, let effort, let modelEditable):
            let model = Self.trimmedOrNil(modelDraft)
            let modelField: String?? = modelEditable || model == nil ? .some(model) : nil
            patch = HarnessSettingsPatch(
                defaultModel: modelField,
                effort: .some(effort == "__default" ? nil : effort)
            )
        case .web(let value):
            patch = HarnessSettingsPatch(web: value)
        case .toolsAllow(let value):
            patch = HarnessSettingsPatch(toolsAllow: Self.csv(value))
        case .toolsDeny(let value):
            patch = HarnessSettingsPatch(toolsDeny: Self.csv(value))
        case .fallbackModel(let value):
            patch = HarnessSettingsPatch(fallbackModel: .some(Self.trimmedOrNil(value)))
        }
        return .valid(SettingsUpdateRequest(harnesses: [harnessID: patch]))
    }

    private static func trimmedOrNil(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func csv(_ value: String) -> [String] {
        value.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

struct HarnessSettingsDraft: Equatable, Sendable {
    var enabled: Bool
    var modelDraft: String
    var effort: String
    var web: String
    var fallbackDraft: String
    var toolsAllowDraft: String
    var toolsDenyDraft: String

    static let defaults = Self(
        enabled: true,
        modelDraft: "",
        effort: "__default",
        web: "auto",
        fallbackDraft: "",
        toolsAllowDraft: "",
        toolsDenyDraft: ""
    )

    static func from(_ settings: HarnessSettings?) -> Self {
        guard let settings else { return .defaults }
        return Self(
            enabled: settings.enabled,
            modelDraft: settings.defaultModel ?? "",
            effort: settings.effort ?? "__default",
            web: settings.web,
            fallbackDraft: settings.fallbackModel ?? "",
            toolsAllowDraft: settings.toolsAllow.joined(separator: ", "),
            toolsDenyDraft: settings.toolsDeny.joined(separator: ", ")
        )
    }

    mutating func adopt(_ settings: HarnessSettings?, preserving lanes: Set<HarnessSettingsLane>) {
        let incoming = Self.from(settings)
        for lane in HarnessSettingsLane.allCases where !lanes.contains(lane) {
            switch lane {
            case .enabled:
                enabled = incoming.enabled
            case .modelAndEffort:
                modelDraft = incoming.modelDraft
                effort = incoming.effort
            case .web:
                web = incoming.web
            case .toolsAllow:
                toolsAllowDraft = incoming.toolsAllowDraft
            case .toolsDeny:
                toolsDenyDraft = incoming.toolsDenyDraft
            case .fallbackModel:
                fallbackDraft = incoming.fallbackDraft
            }
        }
    }

    func edit(for lane: HarnessSettingsLane, modelEditable: Bool) -> HarnessSettingsEdit {
        switch lane {
        case .enabled:
            .enabled(enabled)
        case .modelAndEffort:
            .modelAndEffort(
                modelDraft: modelDraft,
                effort: effort,
                modelEditable: modelEditable
            )
        case .web:
            .web(web)
        case .toolsAllow:
            .toolsAllow(toolsAllowDraft)
        case .toolsDeny:
            .toolsDeny(toolsDenyDraft)
        case .fallbackModel:
            .fallbackModel(fallbackDraft)
        }
    }
}

struct AdmittedHarnessSettingsEdit: Equatable, Sendable {
    let patch: SettingsUpdateRequest
    let target: SettingsSaveTarget
    let generation: Int
}

enum SettingsLanePhase: Equatable, Sendable {
    case clean
    case editing
    case invalid(String)
    case queued
    case saving
    case saved
    case failed(String)

    var preservesDraft: Bool {
        switch self {
        case .clean, .saved: false
        case .editing, .invalid, .queued, .saving, .failed: true
        }
    }
}

enum SettingsSaveOutcome: Equatable, Sendable {
    case saved
    case failed(String)
}

enum SettingsSaveReduction: Equatable, Sendable {
    case settled
    case saveTrailing
}

/// Pure generation reducer. Network/timers stay in SettingsScreen; this owns
/// only which completion is allowed to settle visible state.
struct SettingsLaneReducer: Equatable, Sendable {
    private(set) var generation = 0
    private(set) var phase: SettingsLanePhase = .clean

    mutating func admit(validationError: String?, debounced: Bool = false) -> Int {
        generation &+= 1
        phase = validationError.map(SettingsLanePhase.invalid) ?? (debounced ? .editing : .queued)
        return generation
    }

    mutating func queue(generation captured: Int) -> Bool {
        guard captured == generation else { return false }
        guard case .editing = phase else { return false }
        phase = .queued
        return true
    }

    mutating func beginSave(generation captured: Int) -> Bool {
        guard captured == generation else { return false }
        guard case .queued = phase else { return false }
        phase = .saving
        return true
    }

    mutating func complete(
        generation captured: Int,
        outcome: SettingsSaveOutcome
    ) -> SettingsSaveReduction {
        guard captured == generation else {
            // A newer debounced edit still owns its full 600 ms window. Only
            // a newer edit whose deadline/explicit flush already moved it to
            // queued may be consumed as the current save loop's trailing POST.
            if case .queued = phase { return .saveTrailing }
            return .settled
        }
        switch outcome {
        case .saved:
            phase = .saved
        case .failed(let message):
            phase = .failed(message)
        }
        return .settled
    }

    mutating func clearSaved() {
        if case .saved = phase { phase = .clean }
    }
}

/// Screen-owned per-harness state. Rows may disappear when two locations expose
/// different adapter inventories; their drafts, failures, and retry actions do
/// not, because every mutable lane is addressed by location + harness + lane.
struct HarnessSettingsAutosaveState {
    var drafts: [HarnessSettingsScopeKey: HarnessSettingsDraft] = [:]
    var laneReducers: [HarnessSettingsLaneKey: SettingsLaneReducer] = [:]
    var admittedEdits: [HarnessSettingsLaneKey: AdmittedHarnessSettingsEdit] = [:]
    var savingKeys: Set<HarnessSettingsLaneKey> = []
    var modelCatalogs: [HarnessSettingsScopeKey: HarnessModelsResponse] = [:]
    var debounceTasks: [HarnessSettingsLaneKey: Task<Void, Never>] = [:]

    func draft(
        at scope: HarnessSettingsScopeKey,
        serverSettings: HarnessSettings?
    ) -> HarnessSettingsDraft {
        drafts[scope] ?? HarnessSettingsDraft.from(serverSettings)
    }

    mutating func hydrate(
        _ settings: HarnessSettings?,
        at scope: HarnessSettingsScopeKey
    ) {
        let preserving = Set(HarnessSettingsLane.allCases.filter { lane in
            laneReducers[HarnessSettingsLaneKey(scope: scope, lane: lane)]?
                .phase.preservesDraft == true
        })
        if var current = drafts[scope] {
            current.adopt(settings, preserving: preserving)
            drafts[scope] = current
        } else {
            drafts[scope] = HarnessSettingsDraft.from(settings)
        }
    }
}

enum InteractionTimeoutMode: String, CaseIterable, Identifiable, Sendable {
    case finite
    case disabled
    var id: String { rawValue }
}

struct GlobalSettingsDraft: Equatable, Sendable {
    var routingGoal: String
    var paidFallback: String
    var primaryHarness: String?
    var authPreference: String
    var envInheritance: String
    var eligibleHarnesses: Set<HarnessFamily>
    var maxUsdPerRun: String
    var budgetUnlimited: Bool
    var interactionTimeoutMode: InteractionTimeoutMode
    var interactionTimeoutMinutes: String

    static let defaults = Self(
        routingGoal: "auto",
        paidFallback: "when_unavailable",
        primaryHarness: nil,
        authPreference: "auto",
        envInheritance: "mirror_native",
        eligibleHarnesses: [],
        maxUsdPerRun: "",
        budgetUnlimited: true,
        interactionTimeoutMode: .finite,
        interactionTimeoutMinutes: "15"
    )

    static func from(_ snapshot: SettingsSnapshot) -> Self {
        let timeoutMode: InteractionTimeoutMode
        let timeoutMinutes: String
        switch snapshot.interactionTimeout {
        case .absent:
            timeoutMode = .finite
            timeoutMinutes = "15"
        case .disabled:
            timeoutMode = .disabled
            timeoutMinutes = "15"
        case .finite(let milliseconds):
            timeoutMode = .finite
            timeoutMinutes = minuteText(milliseconds: milliseconds)
        }
        return Self(
            routingGoal: snapshot.routing.goal,
            paidFallback: snapshot.routing.paidFallback,
            primaryHarness: snapshot.routing.primaryHarness,
            authPreference: snapshot.routing.authPreference ?? "auto",
            envInheritance: snapshot.routing.envInheritance,
            eligibleHarnesses: Set(snapshot.routing.eligibleHarnesses.map(HarnessFamily.init(rawValue:))),
            maxUsdPerRun: snapshot.budget.paidBudgetPerRun.finiteMaxUsd.map {
                String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), $0)
            } ?? "",
            budgetUnlimited: snapshot.budget.paidBudgetPerRun == .unlimited,
            interactionTimeoutMode: timeoutMode,
            interactionTimeoutMinutes: timeoutMinutes
        )
    }

    mutating func adopt(_ snapshot: SettingsSnapshot, preserving lanes: Set<SettingsLane>) {
        let incoming = Self.from(snapshot)
        for lane in SettingsLane.allCases where !lanes.contains(lane) {
            switch lane {
            case .routingGoal: routingGoal = incoming.routingGoal
            case .paidFallback: paidFallback = incoming.paidFallback
            case .primaryHarness: primaryHarness = incoming.primaryHarness
            case .eligibleHarnesses: eligibleHarnesses = incoming.eligibleHarnesses
            case .envInheritance: envInheritance = incoming.envInheritance
            case .authPreference: authPreference = incoming.authPreference
            case .paidBudget:
                maxUsdPerRun = incoming.maxUsdPerRun
                budgetUnlimited = incoming.budgetUnlimited
            case .interactionTimeout:
                interactionTimeoutMode = incoming.interactionTimeoutMode
                interactionTimeoutMinutes = incoming.interactionTimeoutMinutes
            }
        }
    }

    func edit(for lane: SettingsLane, qualityTierCount: Int) -> GlobalSettingsEdit {
        switch lane {
        case .routingGoal:
            .routingGoal(routingGoal, qualityTierCount: qualityTierCount)
        case .paidFallback:
            .paidFallback(paidFallback)
        case .primaryHarness:
            .primaryHarness(primaryHarness)
        case .eligibleHarnesses:
            .eligibleHarnesses(eligibleHarnesses.map(\.rawValue).sorted())
        case .envInheritance:
            .envInheritance(envInheritance)
        case .authPreference:
            .authPreference(authPreference)
        case .paidBudget:
            .paidBudgetDraft(unlimited: budgetUnlimited, amount: maxUsdPerRun)
        case .interactionTimeout:
            .interactionTimeout(
                interactionTimeoutMode == .disabled
                    ? .disabled
                    : .finiteMinutes(interactionTimeoutMinutes)
            )
        }
    }

    private static func minuteText(milliseconds: Int) -> String {
        let wholeMinutes = milliseconds / 60_000
        let roundedUp = wholeMinutes + (milliseconds.isMultiple(of: 60_000) ? 0 : 1)
        let maxWholeMinutes = InteractionTimeoutContract.maxFiniteMilliseconds / 60_000
        return String(max(1, min(roundedUp, maxWholeMinutes)))
    }
}
