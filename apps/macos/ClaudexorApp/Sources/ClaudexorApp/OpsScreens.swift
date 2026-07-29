import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Settings

@MainActor
struct SettingsScreen: View {
    @Environment(AppModel.self) var model
    @State private var drafts: [ExecutionLocationID: GlobalSettingsDraft] = [:]
    @State private var laneReducers: [SettingsLaneKey: SettingsLaneReducer] = [:]
    @State private var admittedEdits: [SettingsLaneKey: AdmittedSettingsEdit] = [:]
    @State private var debounceTasks: [SettingsLaneKey: Task<Void, Never>] = [:]
    @State private var savingKeys: Set<SettingsLaneKey> = []
    @State var harnessAutosave = HarnessSettingsAutosaveState()
    @FocusState private var focusedLane: SettingsLane?

    private static let debounceNanoseconds: UInt64 = 600_000_000

    var body: some View {
        @Bindable var model = model
        TabView {
            settingsTab { generalGroup; loadedSettings { advancedGroup } }
                .tabItem { Label("General", systemImage: "gearshape") }
            settingsTab { loadedSettings { routingGroup } }
                .tabItem { Label("Routing", systemImage: "point.3.connected.trianglepath.dotted") }
            settingsTab {
                harnessDoctorGroup
                RemoteHarnessInstallSection()
                loadedSettings { perHarnessGroup }
            }
                .tabItem { Label("Harnesses", systemImage: "cpu") }
            settingsTab { ConnectionsSettingsView() }
                .tabItem { Label("Connections", systemImage: "network") }
            settingsTab { loadedSettings { budgetGroup; interactiveGroup } }
                .tabItem { Label("Budget", systemImage: "dollarsign.circle") }
            settingsTab { secretsGroup; TrustSettingsSection() }
                .tabItem { Label("Secrets", systemImage: "key") }
            settingsTab { appearanceGroup }
                .tabItem { Label("Appearance", systemImage: "paintpalette") }
        }
        .frame(minWidth: 720, minHeight: 600)
        .task { await refreshAll() }
        .onAppear { hydrate(model.activeExecutionLocation) }
        .onChange(of: model.activeSettingsSnapshot) { _, _ in
            hydrate(model.activeExecutionLocation)
        }
        .onChange(of: model.activeExecutionLocation) { _, locationID in
            hydrate(locationID)
        }
        .onChange(of: focusedLane) { oldLane, newLane in
            if let oldLane, oldLane != newLane { flush(oldLane) }
        }
        .onDisappear { flushAll() }
        .sheet(item: $model.settingsRemoteTerminalSheet) { request in
            RemoteTerminalSheet(request: request) {
                model.settingsRemoteTerminalSheet = nil
            }
            .environment(model)
        }
    }


    @ViewBuilder private var budgetGroup: some View {
        settingsGroup("Budget", "dollarsign.circle") {
            HStack {
                Toggle(
                    "Unlimited paid budget",
                    isOn: draftBinding(\.budgetUnlimited, lane: .paidBudget)
                )
                .toggleStyle(.switch)
                .tint(Theme.accent)
                .help("Unlimited still records exact or estimated spend; it removes only the paid cap.")
                laneStatus(.paidBudget)
            }
            TextField(
                "Max USD per run",
                text: draftBinding(\.maxUsdPerRun, lane: .paidBudget, debounced: true)
            )
            .textFieldStyle(.roundedBorder)
            .disabled(activeDraft.budgetUnlimited)
            .focused($focusedLane, equals: .paidBudget)
            .onSubmit { flush(.paidBudget) }
            .help("Finite paid cap. Zero admits only proven-zero or subscription-entitlement routes.")
            QuotaDetailView()
                .frame(minHeight: 260)
        }
    }

    @ViewBuilder private var interactiveGroup: some View {
        settingsGroup("Interactive questions", "questionmark.bubble") {
            Picker(
                "Waiting policy",
                selection: draftBinding(\.interactionTimeoutMode, lane: .interactionTimeout)
            ) {
                Text("Continue after timeout").tag(InteractionTimeoutMode.finite)
                Text("No automatic expiry").tag(InteractionTimeoutMode.disabled)
            }
            .pickerStyle(.segmented)
            .help("Disabled removes automatic expiry only; answering, cancelling, restart cleanup, and terminal cleanup still release the question.")
            if activeDraft.interactionTimeoutMode == .finite {
                HStack(spacing: Theme.Spacing.md) {
                    TextField(
                        "Positive whole minutes",
                        text: draftBinding(
                            \.interactionTimeoutMinutes,
                            lane: .interactionTimeout,
                            debounced: true
                        )
                    )
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 220)
                    .focused($focusedLane, equals: .interactionTimeout)
                    .onSubmit { flush(.interactionTimeout) }
                    .help("How long a run waits before continuing with assumptions. Enter a positive whole number.")
                    laneStatus(.interactionTimeout)
                }
            } else {
                laneStatus(.interactionTimeout)
            }
        }
    }

    @ViewBuilder private var advancedGroup: some View {
        settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudexor for macOS")
                    KeyValueRow(key: "Author", value: AboutInfo.author)
                    KeyValueRow(key: "License", value: AboutInfo.license)
                    // Single source: the bundle version stamped at packaging time
                    // (a hardcoded string here shipped stale in the past).
                    KeyValueRow(key: "Version", value: "v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
                    // Real engine build identity, retained from the connect
                    // handshake (QA-002/D20) instead of dropped: a stale-daemon
                    // skew is visible, and the git sha is "unknown" honestly
                    // until packaged stamping lands (Ф4).
                    KeyValueRow(key: "Engine version", value: model.engineVersionDisplay, mono: true)
                    KeyValueRow(key: "Engine sha", value: model.engineShaDisplay, mono: true)
                    KeyValueRow(key: "Engine", value: "@claudexor/control-api (loopback HTTP+SSE)")
                    aboutLinkRow("Telegram", AboutInfo.telegramLabel, AboutInfo.telegramURL)
                    aboutLinkRow("X", AboutInfo.twitterLabel, AboutInfo.twitterURL)
                    aboutLinkRow("Repository", AboutInfo.repoLabel, AboutInfo.repoURL)
                    KeyValueRow(key: "Review protocol", value: "Inline per-turn review; server-owned decision/apply endpoints")
                    if let runtime = model.activeSettingsSnapshot?.runtime {
                        KeyValueRow(key: "Reviewer timeout", value: "\(max(1, runtime.reviewerTimeoutMs / 60_000)) min")
                        KeyValueRow(key: "Reviewer retries", value: "\(runtime.transientRetry.maxRetries)")
                    }
                    KeyValueRow(key: "Delivery protocol", value: "Inspect artifacts, dry-run before mutation")
                    KeyValueRow(key: "Public architecture", value: "CLAUDEXOR_BIBLE.md + docs/ARCHITECTURE.md", mono: true)
                }
    }

    /// One labeled row carrying a clickable link, laid out like `KeyValueRow`
    /// (secondary caption key on the left, trailing value) so the About block
    /// stays visually uniform. The link tints with the brand accent — inline
    /// links == `brand/accent` (DESIGN_SYSTEM §2.2).
    private func aboutLinkRow(_ key: String, _ label: String, _ url: URL) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            Text(key).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: Theme.Spacing.md)
            Link(label, destination: url)
                .font(.caption)
                .tint(Theme.accent)
                .help("Opens \(url.absoluteString)")
        }
        .padding(.vertical, 1)
    }

    // Thin local shim over the shared SettingsGroup shell (kept so the many
    // call sites and the companion extension stay diff-quiet; the recipe lives
    // in ONE design-system component.
    func settingsGroup<Content: View>(_ title: String, _ systemImage: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        SettingsGroup(title, systemImage: systemImage, content: content)
    }

    func refreshAll() async {
        await model.refreshSettings()
        await model.refreshSecrets()
        _ = await model.refreshAccounts()
        await model.refreshTrust()
        hydrate(model.activeExecutionLocation)
    }

    var activeDraft: GlobalSettingsDraft {
        draft(at: model.activeExecutionLocation)
    }

    private func snapshot(at locationID: ExecutionLocationID) -> SettingsSnapshot? {
        locationID == .local
            ? model.settingsSnapshot
            : model.remoteSettingsSnapshots[locationID]
    }

    private func draft(at locationID: ExecutionLocationID) -> GlobalSettingsDraft {
        drafts[locationID]
            ?? snapshot(at: locationID).map(GlobalSettingsDraft.from)
            ?? .defaults
    }

    func qualityTierCount(at locationID: ExecutionLocationID? = nil) -> Int {
        snapshot(at: locationID ?? model.activeExecutionLocation)?
            .routing.qualityTiers.values.reduce(0) { $0 + $1.count } ?? 0
    }

    func draftBinding<Value>(
        _ keyPath: WritableKeyPath<GlobalSettingsDraft, Value>,
        lane: SettingsLane,
        debounced: Bool = false
    ) -> Binding<Value> {
        let locationID = model.activeExecutionLocation
        return Binding(
            get: { draft(at: locationID)[keyPath: keyPath] },
            set: { value in
                var next = draft(at: locationID)
                next[keyPath: keyPath] = value
                drafts[locationID] = next
                admit(lane, at: locationID, debounced: debounced)
            }
        )
    }

    func primaryHarnessBinding() -> Binding<String> {
        let locationID = model.activeExecutionLocation
        return Binding(
            get: { draft(at: locationID).primaryHarness ?? "__none" },
            set: { value in
                var next = draft(at: locationID)
                next.primaryHarness = value == "__none" ? nil : value
                drafts[locationID] = next
                admit(.primaryHarness, at: locationID, debounced: false)
            }
        )
    }

    func toggleEligibleHarness(_ family: HarnessFamily) {
        let locationID = model.activeExecutionLocation
        var next = draft(at: locationID)
        if next.eligibleHarnesses.contains(family) {
            next.eligibleHarnesses.remove(family)
        } else {
            next.eligibleHarnesses.insert(family)
        }
        drafts[locationID] = next
        admit(.eligibleHarnesses, at: locationID, debounced: false)
    }

    /// Merge fresh server truth lane-by-lane. Drafts with an admitted edit or a
    /// failed save remain owned by the user; unrelated responses cannot clobber
    /// them and settled lanes immediately return to server ownership.
    private func hydrate(_ locationID: ExecutionLocationID) {
        guard let incoming = snapshot(at: locationID) else { return }
        let preserving = Set(SettingsLane.allCases.filter { lane in
            laneReducers[SettingsLaneKey(locationID: locationID, lane: lane)]?
                .phase.preservesDraft == true
        })
        if var current = drafts[locationID] {
            current.adopt(incoming, preserving: preserving)
            drafts[locationID] = current
        } else {
            drafts[locationID] = GlobalSettingsDraft.from(incoming)
        }
    }

    /// Admit one logical field edit, validate it before any POST, and freeze its
    /// exact one-key patch plus execution location before the debounce begins.
    private func admit(
        _ lane: SettingsLane,
        at locationID: ExecutionLocationID,
        debounced: Bool
    ) {
        let key = SettingsLaneKey(locationID: locationID, lane: lane)
        let edit = draft(at: locationID).edit(
            for: lane,
            qualityTierCount: qualityTierCount(at: locationID)
        )
        let validationError: String?
        switch edit.validation {
        case .valid:
            validationError = nil
        case .invalid(let message):
            validationError = message
        }

        var reducer = laneReducers[key] ?? SettingsLaneReducer()
        let generation = reducer.admit(
            validationError: validationError,
            debounced: debounced && validationError == nil
        )
        laneReducers[key] = reducer
        debounceTasks[key]?.cancel()
        debounceTasks.removeValue(forKey: key)

        guard validationError == nil else {
            admittedEdits.removeValue(forKey: key)
            return
        }
        admittedEdits[key] = AdmittedSettingsEdit(
            edit: edit,
            target: SettingsSaveTarget(
                locationID: locationID,
                generation: model.executionLocationGeneration(for: locationID)
            ),
            generation: generation
        )

        if debounced {
            debounceTasks[key] = Task { @MainActor in
                try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
                guard !Task.isCancelled else { return }
                debounceTasks.removeValue(forKey: key)
                queueAndSave(key, generation: generation)
            }
        } else {
            Task { @MainActor in await runSaveLoop(for: key) }
        }
    }

    private func flush(_ lane: SettingsLane) {
        let key = SettingsLaneKey(locationID: model.activeExecutionLocation, lane: lane)
        flush(key)
    }

    private func flush(_ key: SettingsLaneKey) {
        debounceTasks[key]?.cancel()
        debounceTasks.removeValue(forKey: key)
        guard let generation = admittedEdits[key]?.generation else { return }
        queueAndSave(key, generation: generation)
    }

    private func flushAll() {
        for key in Array(admittedEdits.keys) { flush(key) }
    }

    private func queueAndSave(_ key: SettingsLaneKey, generation: Int) {
        var reducer = laneReducers[key] ?? SettingsLaneReducer()
        guard reducer.queue(generation: generation) else { return }
        laneReducers[key] = reducer
        Task { @MainActor in await runSaveLoop(for: key) }
    }

    private func runSaveLoop(for key: SettingsLaneKey) async {
        guard !savingKeys.contains(key) else { return }
        savingKeys.insert(key)
        defer { savingKeys.remove(key) }

        while let admitted = admittedEdits[key] {
            var reducer = laneReducers[key] ?? SettingsLaneReducer()
            guard reducer.beginSave(generation: admitted.generation) else { return }
            laneReducers[key] = reducer

            guard case .valid(let patch) = admitted.edit.validation else { return }
            let result = await model.writeSettings(
                patch,
                at: admitted.target.locationID,
                admittedGeneration: admitted.target.generation
            )
            let outcome: SettingsSaveOutcome = result.succeeded
                ? .saved
                : .failed(result.failureMessage ?? "Could not save this setting.")

            reducer = laneReducers[key] ?? reducer
            let reduction = reducer.complete(
                generation: admitted.generation,
                outcome: outcome
            )
            laneReducers[key] = reducer

            if admittedEdits[key]?.generation == admitted.generation {
                if result.succeeded {
                    admittedEdits.removeValue(forKey: key)
                    hydrate(key.locationID)
                    clearSavedLater(key, generation: admitted.generation)
                } else {
                    return
                }
            }
            guard reduction == .saveTrailing else { return }
            debounceTasks[key]?.cancel()
            debounceTasks.removeValue(forKey: key)
        }
    }

    private func clearSavedLater(_ key: SettingsLaneKey, generation: Int) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard var reducer = laneReducers[key], reducer.generation == generation else { return }
            reducer.clearSaved()
            laneReducers[key] = reducer
        }
    }

    private func retry(_ lane: SettingsLane) {
        let locationID = model.activeExecutionLocation
        admit(lane, at: locationID, debounced: false)
    }

    @ViewBuilder
    func laneStatus(_ lane: SettingsLane) -> some View {
        let key = SettingsLaneKey(locationID: model.activeExecutionLocation, lane: lane)
        switch laneReducers[key]?.phase ?? .clean {
        case .clean:
            EmptyView()
        case .editing:
            Text("Editing…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .invalid(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(Theme.status(.negative))
                .lineLimit(2)
                .help(message)
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
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(Theme.status(.negative))
                    .lineLimit(2)
                    .help(message)
                Button("Retry") { retry(lane) }
                    .buttonStyle(.borderless)
                    .font(.caption2)
            }
        }
    }

}
