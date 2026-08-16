import SwiftUI
import ClaudexorKit

extension SettingsScreen {
    /// The one readiness card. Remote locations route login through their SSH
    /// terminal; local locations retain the existing auth sheet.
    func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let presentation = HarnessReadinessPresentation.from(
            family: family, info: model.harnessInfo(for: family))
        // The remote path starts a PROFILE-LESS login against the engine-default
        // store. A family that has no such store (agy: every account is a named
        // profile) would post a request the daemon must refuse, so the button
        // goes disabled here and names the path that does work — rather than
        // looking live and failing at the server.
        let connectionID = model.activeExecutionLocation.remoteConnectionID
        let remoteHarness = connectionID == nil
            ? nil : SetupHarness(rawValue: family.setupHarnessId)
        let remoteLoginNeedsAccount = remoteHarness != nil
            && !AccountsPresentation.supportsDefaultStoreLogin(family)
        return HarnessReadinessCard(presentation: presentation) {
            Button {
                if let connectionID, let harness = remoteHarness {
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
            .disabled(remoteLoginNeedsAccount)
            .help(
                remoteLoginNeedsAccount
                    ? "\(family.label) has no default sign-in: every account is a named one. Add or open a \(family.label) account in Accounts to sign in on this remote location."
                    : presentation.available
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
