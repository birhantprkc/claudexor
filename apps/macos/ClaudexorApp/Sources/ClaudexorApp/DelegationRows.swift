import SwiftUI

/// Durable requested-but-ineffective Delegate receipt. It is backed by the run
/// summary, so it survives refresh/relaunch instead of living as transient UI
/// state or a one-shot toast.
struct DelegationWarningRow: View {
    let warning: DelegationPresentation.Warning

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.status(.caution))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(warning.title).font(.caption.weight(.semibold))
                Text(warning.detail)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
        .background(Theme.status(.caution).opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.Radius.control))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(warning.title)
        .accessibilityValue(warning.detail)
    }
}

/// A real Claudexor delegated child shown as one ordinary flat run row. The
/// provenance badge and parent link come only from `delegatedFromRunId`.
struct DelegatedRunRow: View {
    @Environment(AppModel.self) private var model
    let child: TaskRun

    private var receipt: DelegationPresentation.ChildReceipt? {
        DelegationPresentation.childReceipt(delegatedFromRunId: child.delegatedFromRunId)
    }

    var body: some View {
        if let receipt {
            HStack(spacing: Theme.Spacing.sm) {
                Button { model.openRun(child.id) } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        statusGlyph
                        Text(child.title).font(.caption).lineLimit(1).truncationMode(.tail)
                        Text(receipt.badge)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, Theme.Spacing.xs).padding(.vertical, 1)
                            .background(Theme.accent.opacity(0.12), in: Capsule())
                            .foregroundStyle(Theme.accent)
                            .accessibilityLabel("Delegated Claudexor run")
                        Text(child.phase.label).font(.caption2).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open delegated run \(child.id) in the thread workspace")

                Button(receipt.parentLabel) { model.openRun(receipt.parentRunId) }
                    .buttonStyle(.borderless)
                    .font(.caption2)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    .help("Open parent run \(receipt.parentRunId)")
                    .accessibilityLabel("Open parent run")
                    .accessibilityValue(receipt.parentRunId)
            }
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.xs)
            .cardSurface(hover: true)
        }
    }

    @ViewBuilder private var statusGlyph: some View {
        if child.phase.isActive {
            ProgressView().controlSize(.small).scaleEffect(0.65).frame(width: 10, height: 10)
        } else {
            Circle().fill(child.phase.color).frame(width: 7, height: 7)
                .accessibilityHidden(true)
        }
    }
}
