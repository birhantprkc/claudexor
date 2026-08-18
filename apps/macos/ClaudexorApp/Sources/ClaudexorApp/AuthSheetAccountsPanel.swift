import SwiftUI

/// AuthSheet host for the ONE shared AccountsSurface (unified account model):
/// every account of the family is a registry row; an empty family offers the
/// bootstrap Sign in (a profile-less login the engine resolves onto the
/// `<harness>-default` row). There is no parallel Native-setup-vs-accounts
/// surface.
struct AuthSheetAccountsPanel: View {
    let family: HarnessFamily
    let actionInFlight: Bool
    /// Blanket lifecycle gate while setup recovery/action state is unresolved.
    let loginDisabled: Bool
    let login: (AccountRowModel) -> Void
    /// The profile-less bootstrap sign-in for an empty family; nil for
    /// families without one (agy signs in only into a named row).
    let bootstrapLogin: (() -> Void)?
    let recheck: () -> Void

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack {
                    SectionLabel("Accounts", systemImage: "person.2")
                    Spacer()
                    Button(action: recheck) {
                        Label("Recheck", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .disabled(actionInFlight)
                    // INV-134: a disabled control names its own cause.
                    .help(actionInFlight
                          ? "Wait for the current action to finish."
                          : "Refresh account readiness")
                }
                AccountsSurface(
                    family: family,
                    login: login,
                    loginDisabled: { _ in loginDisabled },
                    bootstrapLogin: bootstrapLogin,
                    bootstrapLoginDisabled: loginDisabled
                )
            }
        }
    }
}
