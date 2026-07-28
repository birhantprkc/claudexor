import Testing
@testable import ClaudexorApp

@Suite struct ComposerRunControlApplicabilityTests {
    @Test func reviewersAndApprovalsAreAgentOnly() {
        for mode in [RunMode.ask, .plan] {
            let value = ComposerRunControlApplicability.resolve(mode: mode)
            #expect(!value.reviewers.applicable)
            #expect(!value.protectedPathApprovals.applicable)
            #expect(value.reviewers.reason?.contains("Agent") == true)
        }
        let agent = ComposerRunControlApplicability.resolve(mode: .agent)
        #expect(agent.reviewers.applicable)
        #expect(agent.protectedPathApprovals.applicable)
    }
}
