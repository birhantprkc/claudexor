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
//
// The `oauth_url_input` flow (claude today, Antigravity next) adds the paste
// half: the link itself with Open/Copy, a one-shot code field wired to
// POST /v2/setup/jobs/:id/input, and a lapsed-window state that re-issues the
// login instead of leaving a dead link on screen.

struct AuthSheetDeviceCodeCard: View {
    let disclosure: SetupDeviceCodeDisclosure
    /// The job THIS disclosure belongs to. It names the vendor, decides whether
    /// the codex-only browser-callback opt-in exists at all, and publishes the
    /// deadline the sign-in window counts down to — never the sheet's target.
    let job: SetupJob
    let waiting: Bool
    let actionInFlight: Bool
    let cancel: () -> Void
    /// Explicit opt-in for a device-auth-disabled org — switches to the
    /// app-server browser-callback flow. Never invoked silently, and rendered
    /// only where the flow exists (codex): an action that cannot work is not a
    /// thing to explain.
    let useBrowserCallback: () -> Void
    /// Deliver the pasted one-time code (`oauth_url_input` only). Returns the
    /// daemon's refusal reason, or nil once it was accepted; the card holds the
    /// value no longer than the call.
    let submitCode: @MainActor (String) async -> String?
    /// Start a fresh login once the vendor's sign-in window lapsed. That window
    /// cannot be extended, so a new link is the only act left that works.
    let reissue: () -> Void

    @State private var session = EphemeralSignInSession()
    @State private var copied = false
    @State private var linkCopied = false
    @State private var code = ""
    @State private var sending = false
    @State private var submitFailure: String?
    @State private var windowLapsed = false
    /// A code the daemon ACCEPTED for this login. Once set, the deadline may no
    /// longer lapse the card or re-issue the link: the vendor is exchanging that
    /// one-time value, and cancelling it there loses a sign-in that had already
    /// succeeded. The escape hatch stays a deliberate user act.
    @State private var codeDelivered = false
    /// The login attempt the typed code and delivery state belong to.
    @State private var armedJobId = ""

    /// Display name + codex-only affordance for the harness THIS login is for,
    /// from the shared `AuthSheetPresentation` vocabulary.
    private var card: AuthSheetPresentation.LoginDisclosureCard {
        AuthSheetPresentation.loginDisclosureCard(harness: job.harness)
    }
    private var vendor: String { card.vendor }
    /// The paste half renders only for the flow that actually accepts input.
    private var acceptsCode: Bool { disclosure.flow == .oauthUrlInput }
    private var deadline: Date? { AuthSheetJobPanel.parseDate(job.deadlineAt) }
    private var submitAvailability: AuthSheetPresentation.SignInCodeAvailability {
        .init(windowLapsed: windowLapsed, sending: sending, codeField: code)
    }
    /// Copy above the link block. It must never tell the user to open a link
    /// that no longer works, so the lapsed wording points at the replacement.
    private var linkIntro: String {
        if !acceptsCode { return "Complete the sign-in in your browser to finish." }
        return windowLapsed
            ? "That link expired before a code arrived. Get a new one below, then paste the code \(vendor) shows:"
            : "Open this sign-in link, then paste the code \(vendor) shows back here:"
    }

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
                    Text(linkIntro)
                        .font(.caption).foregroundStyle(.secondary)
                    if acceptsCode {
                        // The link IS the handoff for this flow, so it is shown
                        // in full, selectable and copyable — a browser button
                        // alone strands anyone signing in on another device.
                        // Struck through once the window lapsed: the URL is dead
                        // then, and a live-looking link is a false promise.
                        Text(disclosure.verificationUrl)
                            .font(.system(.caption, design: .monospaced))
                            .strikethrough(windowLapsed)
                            .foregroundStyle(windowLapsed ? .secondary : .primary)
                            .padding(Theme.Spacing.sm)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.surfaceCode, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                            .textSelection(.enabled)
                            .accessibilityLabel(AuthSheetPresentation.signInLinkLabel(
                                url: disclosure.verificationUrl, lapsed: windowLapsed))
                    }
                }

                // Every control here ACTS ON the disclosed URL, so all three go
                // dead together the moment the window lapses — and each names
                // that cause instead of looking clickable on a dead link.
                HStack(spacing: Theme.Spacing.sm) {
                    Button {
                        session.open(url: disclosure.verificationUrl)
                    } label: {
                        Label("Open private sign-in", systemImage: "lock.shield")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .disabled(windowLapsed)
                    .help(windowLapsed
                          ? AuthSheetPresentation.lapsedSignInLinkHelp
                          : "Open the \(vendor) sign-in page in a private browser session.")

                    if disclosure.hasUserCode || acceptsCode {
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
                        .disabled(windowLapsed)
                        .help(windowLapsed
                              ? AuthSheetPresentation.lapsedSignInLinkHelp
                              : "Open the \(vendor) sign-in page in your default browser.")
                    }

                    if acceptsCode {
                        // Copies the LINK, not the code — the sign-in can be
                        // finished in any browser or on a phone.
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(disclosure.verificationUrl, forType: .string)
                            linkCopied = true
                        } label: {
                            Label(linkCopied ? "Link copied" : "Copy link",
                                  systemImage: linkCopied ? "checkmark" : "link")
                        }
                        .buttonStyle(.bordered)
                        .disabled(windowLapsed)
                        .help(windowLapsed
                              ? AuthSheetPresentation.lapsedSignInLinkHelp
                              : "Copy the sign-in link to the clipboard.")
                    }
                }

                // Honest, NON-GUARANTEED wording (D-17): Safari honors the
                // request; another default browser may not.
                //
                // NO vendor noun in this paragraph. `HarnessFamily.label` names the
                // HARNESS, and for codex that is "Codex" — a CLI, not the issuer of the
                // account. The revocation risk here belongs to the account provider
                // (OpenAI), so naming the harness made the sentence plainly false.
                Text("Claudexor requested a private browser session. Completing the sign-in in a window that is not signed into another account for this vendor reduces the risk of signing out other apps on this Mac — the vendor may still invalidate sibling sessions on its side.")
                    .font(.caption2).foregroundStyle(.secondary)

                if acceptsCode { signInCodeSection }

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
                    if card.offersBrowserCallback {
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
        // The vendor's sign-in window is fixed and cannot be extended, so a
        // lapsed link is a dead end. Watch the deadline the DAEMON published
        // (never a vendor timeout invented here) and re-issue once the moment it
        // passes — the consumed-once shape the sheet's auto-start uses.
        //
        // Keyed on the job and its DEADLINE, never on the disclosed URL: a job
        // may disclose a provisional capture and then the same URL with more of
        // its tail, and keying on the URL wiped a code the user had already
        // typed the moment that longer capture landed.
        .task(id: "\(job.jobId)|\(job.deadlineAt ?? "")") {
            // Typed input and delivery belong to ONE login attempt; a mere new
            // deadline for the same job leaves them alone.
            if armedJobId != job.jobId {
                armedJobId = job.jobId
                codeDelivered = false
                submitFailure = nil
                code = ""
                copied = false
                linkCopied = false
            }
            // A fresh deadline means an open window again; a delivered code is
            // not un-delivered by it.
            windowLapsed = false
            guard acceptsCode, let deadline else { return }
            let remaining = deadline.timeIntervalSinceNow
            // Already past when this card arrived: show the lapsed state, but
            // let the USER ask for the new link. Auto-firing on a link that was
            // dead before it rendered is how a re-issue loop starts.
            guard remaining > 0 else { lapse(reissuing: false); return }
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
            lapse(reissuing: true)
        }
        .revertsCopyConfirmation($copied)
        .revertsCopyConfirmation($linkCopied)
    }

    /// Close the window the card is showing — unless a code already reached the
    /// daemon (or is on its way there). The vendor is exchanging that one-time
    /// value, and re-issuing would cancel the job mid exchange and burn it, so a
    /// delivered code keeps the card intact and leaves the new link to the user.
    private func lapse(reissuing: Bool) {
        guard AuthSheetPresentation.deadlineMayLapse(
            codeDelivered: codeDelivered, sending: sending) else { return }
        windowLapsed = true
        if reissuing { reissue() }
    }

    /// The `oauth_url_input` paste half. Four honest states: ready to paste,
    /// delivering, DELIVERED (the vendor owns the outcome — the card must not
    /// take the sign-in away from it), and lapsed, where retyping cannot help so
    /// the card hands back a fresh link instead of a field that can only fail.
    @ViewBuilder private var signInCodeSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let deadline, !windowLapsed, !codeDelivered {
                // The countdown's ONE owner while this card is on screen (the
                // setup-job panel yields it); only the copy below is card-local.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Label(AuthSheetJobPanel.deadlineText(deadline, now: context.date),
                          systemImage: "timer")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(deadline <= context.date ? Theme.status(.caution) : .secondary)
                }
            }
            if windowLapsed {
                Label("That sign-in window closed before a code arrived, and it cannot be extended. The link above is dead — Claudexor is issuing a fresh one, and it replaces the link here as soon as it arrives.",
                      systemImage: "clock.badge.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
                newLinkButton(prominent: true)
            } else if codeDelivered {
                // The vendor is exchanging that code now. No countdown and no
                // second paste field: both would only invite cancelling a
                // sign-in that may already have succeeded. The way out stays
                // available but quiet, for the case the vendor refuses it.
                Label("Code delivered. Waiting for \(vendor) to finish the sign-in…",
                      systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                newLinkButton(prominent: false)
            } else {
                Text("Paste the code from the sign-in page:")
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: Theme.Spacing.sm) {
                    TextField("Sign-in code", text: $code)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .onSubmit { submit() }
                        .accessibilityLabel("Sign-in code")
                    Button(action: submit) {
                        Label(sending ? "Sending…" : "Submit", systemImage: "arrow.right.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .disabled(!submitAvailability.enabled)
                    .help(submitAvailability.help)
                }
            }
            if let submitFailure {
                Text(submitFailure)
                    .font(.caption2)
                    .foregroundStyle(Theme.status(.negative))
                    .textSelection(.enabled)
            }
        }
    }

    /// The one act that still works on a dead — or already answered — window:
    /// start a fresh login and disclose a new link. Prominent where it is the
    /// ONLY way forward, quiet where the sign-in may still be completing and
    /// pressing it would throw a live token exchange away.
    @ViewBuilder private func newLinkButton(prominent: Bool) -> some View {
        if prominent {
            Button(action: reissue) { Label("Get a new link", systemImage: "arrow.clockwise") }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accentSolid)
                .disabled(actionInFlight)
                .help(actionInFlight
                      ? "Wait for the current action to finish."
                      : "Start a fresh \(vendor) sign-in and show a new link.")
        } else {
            Button(action: reissue) { Label("Get a new link", systemImage: "arrow.clockwise") }
                .buttonStyle(.bordered)
                .disabled(actionInFlight)
                .help(actionInFlight
                      ? "Wait for the current action to finish."
                      : "Cancel this sign-in and start a fresh one — only if \(vendor) refused the code you sent.")
        }
    }

    /// The pasted value is a one-time secret: it goes straight to the caller and
    /// is cleared from the field once the daemon accepted it. A refusal keeps it
    /// visible on purpose — the user may still need it for the next link.
    private func submit() {
        guard submitAvailability.enabled else { return }
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        submitFailure = nil
        Task { @MainActor in
            let failure = await submitCode(value)
            submitFailure = failure
            // The daemon took it: from here the vendor owns the outcome, and
            // the deadline must never cancel the job out from under it.
            if failure == nil {
                code = ""
                codeDelivered = true
            }
            sending = false
        }
    }
}

private extension View {
    /// Revert a transient "Copied" acknowledgement. It is feedback for one
    /// press, not a permanent label: left latched, the control reads as spent
    /// and the user cannot tell a second copy actually happened.
    func revertsCopyConfirmation(_ flag: Binding<Bool>) -> some View {
        task(id: flag.wrappedValue) {
            guard flag.wrappedValue else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            flag.wrappedValue = false
        }
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
