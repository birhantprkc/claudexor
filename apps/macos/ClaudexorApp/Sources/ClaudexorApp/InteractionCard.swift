import ClaudexorKit
import SwiftUI

/// Live harness question (waiting_on_user). The run is parked until the user
/// answers or a finite expiry/lifecycle release ends the wait; automatic expiry
/// may be disabled. One answer card is shown on every tab of the run.
struct InteractionCard: View {
    @Environment(AppModel.self) private var model
    let interaction: PendingInteraction

    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]
    @State private var sending = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(Theme.status(.attention))
                Text("Needs your answer")
                    .font(.subheadline.weight(.semibold))
                if let harness = interaction.harnessId.flatMap({ HarnessFamily(rawValue: $0) }) {
                    HarnessChip(family: harness)
                }
                Spacer()
                Label(
                    InteractionExpiryPresentation.label(timeoutAt: interaction.timeoutAt),
                    systemImage: "clock"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                .help(InteractionExpiryPresentation.help(timeoutAt: interaction.timeoutAt))
            }

            ForEach(interaction.questions) { question in
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.sm) {
                        if let header = question.header, !header.isEmpty {
                            Text(header)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, Theme.Spacing.sm)
                                .padding(.vertical, Theme.Spacing.xxs)
                                .background(Theme.accent.opacity(0.14), in: Capsule())
                                .foregroundStyle(Theme.accent)
                        }
                        Text(question.question).font(.callout.weight(.medium))
                    }
                    FlowLayout(spacing: Theme.Spacing.sm) {
                        ForEach(question.options, id: \.label) { option in
                            Button {
                                toggle(question: question, label: option.label)
                            } label: {
                                Text(option.label)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, Theme.Spacing.md)
                                    .padding(.vertical, Theme.Spacing.xs)
                            }
                            .buttonStyle(.plain)
                            .selectedChip(active: selections[question.id, default: []].contains(option.label))
                            .help(option.description ?? option.label)
                        }
                    }
                    TextField("Or answer in your own words…", text: binding(for: question.id))
                        .textFieldStyle(.roundedBorder)
                        .font(.callout)
                }
            }

            HStack(spacing: Theme.Spacing.md) {
                Button {
                    submit()
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Send answer", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(sending || !hasAnyAnswer)
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.status(.attention).opacity(0.5))
        .textSelection(.enabled)
    }

    private var hasAnyAnswer: Bool {
        InteractionAnswerComposer.hasAnyAnswer(interaction, selections: selections, freeText: freeText)
    }

    private func binding(for questionId: String) -> Binding<String> {
        Binding(get: { freeText[questionId] ?? "" }, set: { freeText[questionId] = $0 })
    }

    private func toggle(question: InteractionQuestion, label: String) {
        var set = selections[question.id, default: []]
        if set.contains(label) {
            set.remove(label)
        } else {
            if !question.multiSelect { set.removeAll() }
            set.insert(label)
        }
        selections[question.id] = set
    }

    private func submit() {
        let answers = InteractionAnswerComposer.payloads(interaction, selections: selections, freeText: freeText)
        guard !answers.isEmpty else { return }
        sending = true
        errorMessage = nil
        Task {
            let failure = await model.answerInteraction(
                runId: interaction.runId,
                interactionId: interaction.interactionId,
                answers: answers)
            sending = false
            errorMessage = failure
        }
    }
}

/// Visible expiry truth for the card. A nil deadline is a deliberate disabled
/// policy, not missing data, so it must remain explicit on every UI surface.
@MainActor
enum InteractionExpiryPresentation {
    static func label(timeoutAt: String?, now: Date = .now) -> String {
        guard let timeoutAt else { return "No automatic expiry" }
        // Shared static formatters (AppModel.parseEventDate): formatter
        // allocation is expensive and this label re-evaluates on every render.
        guard let date = AppModel.parseEventDate(timeoutAt) else { return "Expiry unavailable" }
        let remaining = date.timeIntervalSince(now)
        guard remaining > 0 else { return "expiring" }
        let minutes = Int(remaining / 60)
        return minutes > 0 ? "auto-declines in \(minutes) min" : "auto-declines soon"
    }

    static func help(timeoutAt: String?) -> String {
        timeoutAt == nil
            ? "This question waits until it is answered, cancelled, or released by run termination or restart."
            : "Unanswered questions decline automatically; the model continues with stated assumptions."
    }
}

/// Pure answer composer for a live interaction — the affordance's completeness
/// gate (`hasAnyAnswer`) and the typed answer payloads are extracted so they are
/// unit-tested (InteractionCardTests); the InteractionCard view only collects
/// selections/free text and calls `AppModel.answerInteraction`.
enum InteractionAnswerComposer {
    static func hasAnyAnswer(_ interaction: PendingInteraction,
                             selections: [String: Set<String>],
                             freeText: [String: String]) -> Bool {
        interaction.questions.contains { q in
            !selections[q.id, default: []].isEmpty
                || !(freeText[q.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    static func payloads(_ interaction: PendingInteraction,
                         selections: [String: Set<String>],
                         freeText: [String: String]) -> [InteractionAnswerPayload] {
        interaction.questions.compactMap { q -> InteractionAnswerPayload? in
            let labels = Array(selections[q.id, default: []])
            let text = (freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !labels.isEmpty || !text.isEmpty else { return nil }
            return InteractionAnswerPayload(questionId: q.id, selectedLabels: labels,
                                            freeText: text.isEmpty ? nil : text)
        }
    }
}
