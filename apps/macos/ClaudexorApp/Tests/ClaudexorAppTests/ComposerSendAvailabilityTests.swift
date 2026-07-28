import Testing
@testable import ClaudexorApp

@Suite struct ComposerSendAvailabilityTests {
    @Test func emptyMessageHasOneCausalReason() {
        let availability = ComposerSendAvailability.resolve(message: "   ", blockers: [])
        #expect(!availability.enabled)
        #expect(availability.name == "Send")
        #expect(availability.help == "Type a message to send")
        #expect(availability.disabledReason == availability.help)
    }

    @Test func optionBlockerDrivesDisabledStateHelpAndReasonTogether() {
        let availability = ComposerSendAvailability.resolve(
            message: "go",
            blockers: [.reviewer("Fix the reviewer panel in More options to send")]
        )
        #expect(!availability.enabled)
        #expect(availability.help == "Fix the reviewer panel in More options to send")
        #expect(availability.disabledReason == availability.help)
    }

    @Test func validMessageUsesActiveActionHelp() {
        let availability = ComposerSendAvailability.resolve(message: "go", blockers: [])
        #expect(availability.enabled)
        #expect(availability.help == "Send (Command-Return)")
        #expect(availability.disabledReason == nil)
    }
}
