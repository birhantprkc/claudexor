import SwiftUI
import ClaudexorKit

extension SettingsScreen {
    /// The one readiness card. Remote locations route login through their SSH
    /// terminal; local locations retain the existing auth sheet.
    func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let presentation = HarnessReadinessPresentation.from(
            family: family, info: model.harnessInfo(for: family))
        return HarnessReadinessCard(presentation: presentation) {
            Button {
                if let connectionID = model.activeExecutionLocation.remoteConnectionID,
                   let harness = SetupHarness(rawValue: family.setupHarnessId)
                {
                    Task {
                        await model.startRemoteLogin(
                            connectionID: connectionID, harness: harness)
                    }
                } else {
                    model.authSheetTarget = AuthSheetTarget(family: family)
                }
            } label: {
                Label(
                    presentation.available ? "Manage" : "Setup",
                    systemImage: presentation.available
                        ? "slider.horizontal.3"
                        : "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.bordered)
            .tint(Theme.accent)
            .help(
                presentation.available
                    ? "Open \(family.label) auth details and fallback key management."
                    : "Open setup/auth actions for \(family.label).")
            Button {
                Task {
                    await model.refreshHarnesses(fresh: true, markStaleOnFailure: true)
                }
            } label: {
                Label("Recheck", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh install/auth/capability status after setup.")
        }
    }
}
