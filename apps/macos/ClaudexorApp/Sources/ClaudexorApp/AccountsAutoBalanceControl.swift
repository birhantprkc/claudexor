// MARK: - Auto-switch-at-quota control (tri-state Off/Auto/On since A6)
//
// Split from AccountsPopover.swift to a smaller owner (complexity ratchet).
// The pure target-set/aggregate logic lives in AccountsPresentation.swift
// (AccountsAutoBalance); this file is only the popover's control surface.
import SwiftUI

struct AccountsAutoBalanceControl: View {
    @Environment(AppModel.self) private var model

    @ViewBuilder var body: some View {
        let state = model.autoBalanceState
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Theme.Spacing.sm) {
                Text("Auto-switch accounts at quota limit").font(.callout)
                // Per-harness actions disagree → the aggregate is indeterminate:
                // show "—" (no selected segment) rather than misreporting it.
                if state == .mixed {
                    Text("—")
                        .font(.callout.weight(.semibold)).foregroundStyle(Theme.status(.caution))
                        .help("Harnesses disagree — pick a mode to set them all consistently.")
                }
                Spacer(minLength: Theme.Spacing.sm)
                Picker("", selection: Binding<AccountsAutoBalance.Choice?>(
                    get: { choice(state) },
                    set: { choice in
                        guard let choice else { return }
                        Task { await model.setAutoBalance(choice) }
                    }
                )) {
                    Text("Off").tag(AccountsAutoBalance.Choice?.some(.fail))
                    Text("Auto").tag(AccountsAutoBalance.Choice?.some(.auto))
                    Text("On").tag(AccountsAutoBalance.Choice?.some(.rotate))
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .disabled(state == .unavailable)
            }
            Text(caption(state))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// The selected segment for the aggregate state; `mixed`/`unavailable`
    /// select nothing.
    private func choice(_ state: AccountsAutoBalance.State) -> AccountsAutoBalance.Choice? {
        switch state {
        case .on: return .rotate
        case .auto: return .auto
        case .off: return .fail
        case .mixed, .unavailable: return nil
        }
    }

    private func caption(_ state: AccountsAutoBalance.State) -> String {
        switch state {
        case .unavailable:
            // Honest about the disclosed asymmetry: Cursor accounts already
            // auto-switch reactively under the engine's kind-aware default —
            // this control only governs harnesses with a quota source, so its
            // absence must not read as "auto-switch is off".
            return "Add a second Claude, Codex, or agy account to control auto-switch here; Cursor accounts already switch automatically at a vendor limit."
        case .mixed:
            return "Harnesses disagree (—) — pick a mode to set them all consistently."
        case .auto:
            return "Subscription accounts switch to another enabled account at their quota limit; metered API keys stop instead."
        case .on:
            return "When one account hits its quota, runs continue on another enabled account of the same harness."
        case .off:
            return "Runs stop at a quota limit instead of switching accounts."
        }
    }
}
