import SwiftUI
import ClaudexorKit

/// One account row inside the popover, built on the shared `AlignedListRow`
/// component (UI cut 3 §1). The identity block (status dot + name + SINGLE-LINE
/// quota/detail) and the shared-Grid trailing columns are owned by the
/// component, so this row cannot reintroduce the owner-round-3 wrap/drift bug.
/// The F1 engine cut deleted user-settable Active: the Enabled toggle is the
/// only routing control, and the row routing would pick next carries a quiet
/// informational "Next up" badge (never a control); per-thread pinning lives on
/// the composer chip.
struct AccountRowView: View {
    let row: AccountRowModel
    let login: () -> Void
    var loginDisabled = false
    /// V11b: live Enabled toggle action — PATCHes the profile / native setting.
    /// nil renders a read-only toggle (defensive; the surface always supplies it).
    var setEnabled: ((Bool) -> Void)? = nil
    /// The confirmed Remove action — EVERY row carries one under the unified
    /// account model (nil only while another delete is settling).
    var delete: (() -> Void)? = nil

    /// Per-cell width FLOORS for the trailing control columns (owner F8). The
    /// shared Grid in `AlignedList` pins the true collinear edge; these only stop
    /// a cell collapsing narrower than its siblings. The column SET is stable
    /// across rows (`AccountsPresentation.columns`), so the toggle and Manage
    /// button never shift between rows.
    private enum Col {
        static let enabled: CGFloat = 30
        static let manage: CGFloat = 64
        static let delete: CGFloat = 18
    }

    var body: some View {
        AlignedListRow(identity: identity) {
            // Column 0 (enabled): the collinear anchor across every row.
            enabledToggle.alignedControlColumn(minWidth: Col.enabled)
            // Column 1 (manage / log in).
            manageButton.alignedControlColumn(minWidth: Col.manage)
            // Column 2 (delete): a clear spacer reserves the column when absent.
            deleteCell.alignedControlColumn(minWidth: Col.delete)
        }
    }

    /// The identity block: readiness dot + name (+ harness badge + optional
    /// "Next up") + the ONE single-line quota line + optional single-line detail.
    private var identity: AlignedRowIdentity {
        var badges: [AlignedRowBadge] = [
            // Every account is a registry row of its harness (unified account
            // model — the "CLI login" pseudo-row is retired). API keys are
            // routes, not synthetic account rows.
            AlignedRowBadge(row.harnessId, emphasis: .secondary)
        ]
        if row.nextUp {
            // F1 informational hint: this is who an unpinned run routes to next.
            badges.append(AlignedRowBadge("Next up", systemImage: "arrow.turn.down.right", emphasis: .accent))
        }
        var details: [AlignedRowDetail] = []
        details.append(quotaDetail)
        // Identity and readiness are different facts. Failures stay inline;
        // healthy rows with identity keep the detail in status-marker help so a
        // long account list remains compact.
        for (index, line) in row.secondaryLines.enumerated() {
            details.append(AlignedRowDetail(index + 1, line, emphasis: .secondary))
        }
        return AlignedRowIdentity(
            dotColor: row.readiness.color,
            dotHelp: readinessHelp,
            title: row.displayName,
            badges: badges,
            details: details)
    }

    private var readinessHelp: String {
        let summary = row.verified ? "Verified" : "Not verified — log in"
        guard let detail = row.hiddenReadinessDetail else { return summary }
        return "\(summary)\n\(detail)"
    }

    /// ONE compact quota detail: the worst window's used-% and its reset, as a
    /// single-line string (the component enforces single-line + tail truncation).
    private var quotaDetail: AlignedRowDetail {
        if row.quotaAvailabilityState == "exhausted" {
            var text = "Quota exhausted"
            if let reset = formattedDate(row.quotaAvailabilityResetAt) {
                text += " · resets \(reset)"
            }
            return AlignedRowDetail(0, text, emphasis: .warning)
        }
        if row.quotaAvailabilityState == "cooldown" {
            var text = "Quota cooling down"
            if let reset = formattedDate(row.quotaAvailabilityResetAt) {
                text += " · until \(reset)"
            }
            return AlignedRowDetail(0, text, emphasis: .warning)
        }
        if let window = row.worstWindow, let pct = row.worstPercent {
            var text = "\(pct)% used"
            if let reset = formattedDate(window.resetsAt) { text += " · resets \(reset)" }
            if let scoped = row.scopedQuotaLabel { text += " · \(scoped)" }
            return AlignedRowDetail(
                0, text,
                emphasis: pct >= 90 || row.scopedQuotaLabel != nil ? .warning : .secondary,
                monospacedDigit: true)
        }
        if let scoped = row.scopedQuotaLabel {
            return AlignedRowDetail(0, scoped, emphasis: .warning)
        }
        return AlignedRowDetail(0, "Quota unknown", emphasis: .secondary)
    }

    /// D25 Enabled: symmetric on every row and LIVE — every row PATCHes its own
    /// `enabled` through the profile route (unified account model). Reads wire
    /// truth; the set fires the PATCH (reload-after-PATCH — no faked client
    /// state).
    private var enabledToggle: some View {
        Toggle("", isOn: Binding(get: { row.enabled }, set: { setEnabled?($0) }))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .tint(Theme.accent)
            .disabled(setEnabled == nil)
            .help(enabledHelp)
    }

    private var enabledHelp: String {
        row.enabled
            ? "Enabled — participates in account pickers and the auto-rotation pool. Turn off to exclude it."
            : "Disabled — excluded from account pickers and the auto-rotation pool."
    }

    private var manageButton: some View {
        Button(row.verified ? "Manage" : "Log in", action: login)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loginDisabled)
            .fixedSize()
            .help(row.verified
                ? "Manage this account's native login"
                : "Start the official CLI login for this account — the sign-in link appears right here, no Terminal window")
    }

    /// The delete control, or a clear spacer that still holds the column (so the
    /// toggle/Manage columns to its left never shift while another delete is
    /// settling and the action is briefly absent).
    @ViewBuilder private var deleteCell: some View {
        if let delete {
            Button(role: .destructive, action: delete) { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Remove this account: its registration and its own login/key. Your \(row.family.label) account at the vendor survives — Sign in restores it.")
        } else {
            AlignedColumnSpacer(width: Col.delete)
        }
    }
}
