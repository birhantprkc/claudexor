//
// HarnessDefaultsRow — per-harness defaults with field-owned autosave lanes.
//

import AppKit
import ClaudexorKit
import SwiftUI

@MainActor
struct HarnessDefaultsRow: View {
    @Environment(AppModel.self) private var model
    let family: HarnessFamily
    let settings: HarnessSettings?
    @Binding var autosave: HarnessSettingsAutosaveState
    @FocusState private var focusedLane: HarnessSettingsLane?

    private static let debounceNanoseconds: UInt64 = 600_000_000

    private var activeScope: HarnessSettingsScopeKey {
        HarnessSettingsScopeKey(
            locationID: model.activeExecutionLocation,
            harnessID: family.rawValue
        )
    }

    private var draft: HarnessSettingsDraft {
        autosave.draft(at: activeScope, serverSettings: settings(at: activeScope))
    }

    private var effortLevels: [String] {
        let info = model.harnessInfo(for: family)
        let chosenModel = draft.modelDraft.trimmingCharacters(in: .whitespaces)
        var levels = (chosenModel.isEmpty ? nil : info?.modelEffortLevels[chosenModel])
            ?? info?.effortLevels ?? []
        if draft.effort != "__default", !levels.contains(draft.effort) {
            levels.insert(draft.effort, at: 0)
        }
        return levels
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            AlignedList {
                AlignedListRow {
                    HarnessChip(family: family, selected: draft.enabled, available: true)
                } controls: {
                    laneStatus(.enabled)
                        .alignedControlColumn(minWidth: 60, alignment: .trailing)
                    Toggle(
                        "Enabled",
                        isOn: draftBinding(\.enabled, lane: .enabled)
                    )
                    .toggleStyle(.switch)
                    .tint(Theme.accent)
                    .labelsHidden()
                    .help("Disabled harnesses are excluded from routing and pools.")
                    .alignedControlColumn(minWidth: 40, alignment: .trailing)
                }
            }

            HStack(spacing: Theme.Spacing.sm) {
                // Settings enumeration stays unfiltered: this is global model
                // truth, not a per-turn route restriction.
                HarnessModelOverrideField(
                    family: family,
                    modelDraft: draftBinding(\.modelDraft, lane: .modelAndEffort),
                    fetch: { await model.harnessModels(for: $0) },
                    models: modelCatalogBinding(at: activeScope)
                )
                .id(activeScope)
                if !effortLevels.isEmpty {
                    Picker(
                        "Effort",
                        selection: draftBinding(\.effort, lane: .modelAndEffort)
                    ) {
                        Text("Default").tag("__default")
                        ForEach(effortLevels, id: \.self) { Text($0).tag($0) }
                    }
                    .fixedSize()
                    .help("Adapter-declared reasoning effort for \(family.label).")
                }
                laneStatus(.modelAndEffort)
            }

            HStack(spacing: Theme.Spacing.sm) {
                Picker("Web", selection: draftBinding(\.web, lane: .web)) {
                    Text("Auto").tag("auto")
                    Text("Off").tag("off")
                    Text("Cached").tag("cached")
                    Text("Live").tag("live")
                }
                .fixedSize()
                .help("Default external web/search policy for this harness.")
                laneStatus(.web)
            }

            HStack(spacing: Theme.Spacing.sm) {
                TextField(
                    "fallback model",
                    text: draftBinding(
                        \.fallbackDraft,
                        lane: .fallbackModel,
                        debounced: true
                    )
                )
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .focused($focusedLane, equals: .fallbackModel)
                .onSubmit { flush(.fallbackModel) }
                .help("Model used if the primary model is unavailable. Empty = none.")
                laneStatus(.fallbackModel)
            }

            HStack(spacing: Theme.Spacing.sm) {
                TextField(
                    "tools allow (comma-separated)",
                    text: draftBinding(\.toolsAllowDraft, lane: .toolsAllow, debounced: true)
                )
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .focused($focusedLane, equals: .toolsAllow)
                .onSubmit { flush(.toolsAllow) }
                .help("Allow-list of tool ids for \(family.label). Empty = harness default.")
                laneStatus(.toolsAllow)
            }

            HStack(spacing: Theme.Spacing.sm) {
                TextField(
                    "tools deny (comma-separated)",
                    text: draftBinding(\.toolsDenyDraft, lane: .toolsDeny, debounced: true)
                )
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .focused($focusedLane, equals: .toolsDeny)
                .onSubmit { flush(.toolsDeny) }
                .help("Deny-list of tool ids for \(family.label).")
                laneStatus(.toolsDeny)
            }
        }
        .padding(Theme.Spacing.sm)
        .background(
            Theme.surfaceRaisedHi.opacity(0.5),
            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
        )
        .onAppear { hydrate(activeScope) }
        .onChange(of: settings) { _, _ in hydrate(activeScope) }
        .onChange(of: model.activeExecutionLocation) { _, _ in hydrate(activeScope) }
        .onChange(of: focusedLane) { oldLane, newLane in
            if let oldLane, oldLane != newLane { flush(oldLane) }
        }
        .onDisappear { flushAll() }
    }

    private func draftBinding<Value>(
        _ keyPath: WritableKeyPath<HarnessSettingsDraft, Value>,
        lane: HarnessSettingsLane,
        debounced: Bool = false
    ) -> Binding<Value> {
        let scope = activeScope
        return Binding(
            get: {
                autosave.draft(at: scope, serverSettings: settings(at: scope))[keyPath: keyPath]
            },
            set: { value in
                var next = autosave.draft(
                    at: scope,
                    serverSettings: settings(at: scope)
                )
                next[keyPath: keyPath] = value
                autosave.drafts[scope] = next
                admit(lane, at: scope, debounced: debounced)
            }
        )
    }

    private func modelCatalogBinding(
        at scope: HarnessSettingsScopeKey
    ) -> Binding<HarnessModelsResponse?> {
        Binding(
            get: { autosave.modelCatalogs[scope] },
            set: { value in
                if let value {
                    autosave.modelCatalogs[scope] = value
                } else {
                    autosave.modelCatalogs.removeValue(forKey: scope)
                }
            }
        )
    }

    private func settings(at scope: HarnessSettingsScopeKey) -> HarnessSettings? {
        let snapshot = scope.locationID == .local
            ? model.settingsSnapshot
            : model.remoteSettingsSnapshots[scope.locationID]
        return snapshot?.harnesses?[scope.harnessID]
    }

    /// Server refreshes update only server-owned lanes. A response for Web can
    /// never clobber a Tools draft, and a pending Tools edit never hides an
    /// externally changed sibling field.
    private func hydrate(_ scope: HarnessSettingsScopeKey) {
        autosave.hydrate(settings(at: scope), at: scope)
    }

    private func admit(
        _ lane: HarnessSettingsLane,
        at scope: HarnessSettingsScopeKey,
        debounced: Bool
    ) {
        let key = HarnessSettingsLaneKey(scope: scope, lane: lane)
        let edit = autosave.draft(
            at: scope,
            serverSettings: settings(at: scope)
        ).edit(for: lane, modelEditable: autosave.modelCatalogs[scope]?.canEnumerate == true)
        guard case .valid(let patch) = edit.validation(harnessID: family.rawValue) else { return }

        var reducer = autosave.laneReducers[key] ?? SettingsLaneReducer()
        let generation = reducer.admit(validationError: nil, debounced: debounced)
        autosave.laneReducers[key] = reducer
        autosave.debounceTasks[key]?.cancel()
        autosave.debounceTasks.removeValue(forKey: key)

        autosave.admittedEdits[key] = AdmittedHarnessSettingsEdit(
            patch: patch,
            target: SettingsSaveTarget(
                locationID: scope.locationID,
                generation: model.settingsGeneration(for: scope.locationID)
            ),
            generation: generation
        )

        if debounced {
            autosave.debounceTasks[key] = Task { @MainActor in
                try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
                guard !Task.isCancelled else { return }
                autosave.debounceTasks.removeValue(forKey: key)
                queueAndSave(key, generation: generation)
            }
        } else {
            Task { @MainActor in await runSaveLoop(for: key) }
        }
    }

    private func flush(_ lane: HarnessSettingsLane) {
        flush(HarnessSettingsLaneKey(scope: activeScope, lane: lane))
    }

    private func flush(_ key: HarnessSettingsLaneKey) {
        autosave.debounceTasks[key]?.cancel()
        autosave.debounceTasks.removeValue(forKey: key)
        guard let generation = autosave.admittedEdits[key]?.generation else { return }
        queueAndSave(key, generation: generation)
    }

    private func flushAll() {
        for key in autosave.admittedEdits.keys where key.harnessID == family.rawValue {
            flush(key)
        }
    }

    private func queueAndSave(_ key: HarnessSettingsLaneKey, generation: Int) {
        var reducer = autosave.laneReducers[key] ?? SettingsLaneReducer()
        guard reducer.queue(generation: generation) else { return }
        autosave.laneReducers[key] = reducer
        Task { @MainActor in await runSaveLoop(for: key) }
    }

    private func runSaveLoop(for key: HarnessSettingsLaneKey) async {
        guard !autosave.savingKeys.contains(key) else { return }
        autosave.savingKeys.insert(key)
        defer { autosave.savingKeys.remove(key) }

        while let admitted = autosave.admittedEdits[key] {
            var reducer = autosave.laneReducers[key] ?? SettingsLaneReducer()
            guard reducer.beginSave(generation: admitted.generation) else { return }
            autosave.laneReducers[key] = reducer

            let result = await model.writeSettings(
                admitted.patch,
                at: admitted.target.locationID,
                admittedGeneration: admitted.target.generation
            )
            let outcome: SettingsSaveOutcome = result.succeeded
                ? .saved
                : .failed(result.failureMessage ?? "Could not save this setting.")

            reducer = autosave.laneReducers[key] ?? reducer
            let reduction = reducer.complete(
                generation: admitted.generation,
                outcome: outcome
            )
            autosave.laneReducers[key] = reducer

            if autosave.admittedEdits[key]?.generation == admitted.generation {
                if result.succeeded {
                    autosave.admittedEdits.removeValue(forKey: key)
                    let scope = HarnessSettingsScopeKey(
                        locationID: key.locationID,
                        harnessID: key.harnessID
                    )
                    hydrate(scope)
                    clearSavedLater(key, generation: admitted.generation)
                } else {
                    return
                }
            }
            guard reduction == .saveTrailing else { return }
            autosave.debounceTasks[key]?.cancel()
            autosave.debounceTasks.removeValue(forKey: key)
        }
    }

    private func clearSavedLater(_ key: HarnessSettingsLaneKey, generation: Int) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard var reducer = autosave.laneReducers[key],
                  reducer.generation == generation
            else { return }
            reducer.clearSaved()
            autosave.laneReducers[key] = reducer
        }
    }

    private func retry(_ lane: HarnessSettingsLane) {
        admit(lane, at: activeScope, debounced: false)
    }

    @ViewBuilder
    private func laneStatus(_ lane: HarnessSettingsLane) -> some View {
        let key = HarnessSettingsLaneKey(scope: activeScope, lane: lane)
        switch autosave.laneReducers[key]?.phase ?? .clean {
        case .clean:
            EmptyView()
        case .editing:
            Text("Editing…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .invalid(let message):
            failureLabel(message)
        case .queued, .saving:
            Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(Theme.status(.positive))
        case .failed(let message):
            HStack(spacing: Theme.Spacing.xs) {
                failureLabel(message)
                Button("Retry") { retry(lane) }
                    .buttonStyle(.borderless)
                    .font(.caption2)
            }
        }
    }

    private func failureLabel(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.caption2)
            .foregroundStyle(Theme.status(.negative))
            .lineLimit(2)
            .help(message)
    }
}
