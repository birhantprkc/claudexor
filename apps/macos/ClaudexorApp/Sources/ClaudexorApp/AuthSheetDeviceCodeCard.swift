import SwiftUI
import AppKit
import AuthenticationServices
import ClaudexorKit

// MARK: - D-17 login disclosure AuthSheet card
//
// The no-Terminal login surface: a large one-time code with an explicit Copy
// button (never auto-copied), an "Open private sign-in" button that starts an
// ephemeral ASWebAuthenticationSession, a Waiting state, and Cancel. Codex's
// app-server flows also carry an explicit browser-callback opt-in for orgs that
// disable device-code login (no silent fallback). Pure rendering — every
// mutation is a caller closure.
//
// This card is NOT codex-only: a terminal-mode claude/cursor login discloses
// its captured `oauth_url` through the same overlay, so every line naming a
// vendor reads it from the job instead of asserting OpenAI.

struct AuthSheetDeviceCodeCard: View {
    let disclosure: SetupDeviceCodeDisclosure
    /// Display name of the harness THIS login is for, from the shared
    /// `HarnessFamily.label` vocabulary (harness id when there is no label).
    let vendor: String
    let waiting: Bool
    let actionInFlight: Bool
    let cancel: () -> Void
    /// Explicit opt-in for a device-auth-disabled org — switches to the
    /// app-server browser-callback flow. Never invoked silently. nil where the
    /// action does not exist (it is codex-only), and then it is not offered at
    /// all: an action that cannot work is not a thing to explain.
    let useBrowserCallback: (() -> Void)?

    @State private var session = EphemeralSignInSession()
    @State private var copied = false

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Sign in to \(vendor)", systemImage: "person.badge.key")

                if disclosure.hasUserCode {
                    Text("Enter this one-time code on the \(vendor) sign-in page:")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: Theme.Spacing.md) {
                        Text(disclosure.userCode)
                            .font(.system(size: 30, weight: .bold, design: .monospaced))
                            .tracking(2)
                            .textSelection(.enabled)
                            .accessibilityLabel("One-time code \(disclosure.userCode)")
                        Button {
                            // Explicit copy only — the one-time code is NEVER
                            // auto-copied to the pasteboard.
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(disclosure.userCode, forType: .string)
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        .buttonStyle(.bordered)
                        .help("Copy the one-time code to the clipboard.")
                    }
                } else {
                    Text("Complete the sign-in in your browser to finish.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                HStack(spacing: Theme.Spacing.sm) {
                    Button {
                        session.open(url: disclosure.verificationUrl)
                    } label: {
                        Label("Open private sign-in", systemImage: "lock.shield")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .help("Open the \(vendor) sign-in page in a private browser session.")

                    if disclosure.hasUserCode {
                        // A plain fallback to the default browser for anyone who
                        // prefers it; the honest wording below applies to the
                        // private-session button only.
                        Button {
                            if let url = URL(string: disclosure.verificationUrl) {
                                NSWorkspace.shared.open(url)
                            }
                        } label: {
                            Label("Open in browser", systemImage: "safari")
                        }
                        .buttonStyle(.bordered)
                    }
                }

                // Honest, NON-GUARANTEED wording (D-17): Safari honors the
                // request; another default browser may not.
                Text("Claudexor requested a private browser session. Completing the sign-in in a window that is not signed into another \(vendor) account reduces the risk of signing out other \(vendor) apps on this Mac — \(vendor) may still invalidate sibling sessions on its side.")
                    .font(.caption2).foregroundStyle(.secondary)

                if waiting {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Waiting for \(vendor)…").font(.caption).foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: Theme.Spacing.sm) {
                    Button("Cancel", role: .destructive) {
                        session.cancel()
                        cancel()
                    }
                    .buttonStyle(.bordered)
                    .disabled(actionInFlight)
                    .help("Cancel this sign-in.")

                    Spacer(minLength: 0)

                    // Explicit opt-in, never a silent fallback: for orgs that
                    // disable device-code login (ChatGPT → Security). Absent
                    // entirely on a login that has no such flow to switch to.
                    if let useBrowserCallback {
                        Button {
                            session.cancel()
                            useBrowserCallback()
                        } label: {
                            Label("Use browser sign-in instead", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .buttonStyle(.link)
                        .disabled(actionInFlight)
                        .help("If your organization disabled device-code login, switch to the browser-callback sign-in.")
                    }
                }
            }
        }
        // The ephemeral session is retained while the card is shown and
        // cancelled when it disappears (the app-server owns real completion).
        .onDisappear { session.cancel() }
    }
}

/// Wraps a single ephemeral ASWebAuthenticationSession pointed at the vendor's
/// verification URL. There is no app callback for these flows — the app-server
/// (or the terminal login itself) reports completion — so the session is opened
/// for isolation and cancelled when the login ends.
/// prefersEphemeralWebBrowserSession requests a private session (honored by
/// Safari; not guaranteed for every default browser).
@MainActor
final class EphemeralSignInSession: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(url string: String) {
        guard let url = URL(string: string) else { return }
        cancel()
        // A callback scheme that the device-code flow never redirects to; the
        // session simply hosts the private browser until the app-server confirms.
        // The completion MUST be @Sendable-nonisolated: AuthenticationServices
        // invokes it on a background queue when the session ends, and a closure
        // formed in this @MainActor class otherwise inherits main isolation —
        // the runtime isolation assert then SIGTRAPs the app right after a
        // successful sign-in (owner live test, 2026-07-24).
        let completion: @Sendable (URL?, Error?) -> Void = { _, _ in }
        let created = ASWebAuthenticationSession(
            url: url, callbackURLScheme: "claudexor-auth", completionHandler: completion)
        created.prefersEphemeralWebBrowserSession = true
        created.presentationContextProvider = self
        self.session = created
        created.start()
    }

    func cancel() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow ?? ASPresentationAnchor()
    }
}
