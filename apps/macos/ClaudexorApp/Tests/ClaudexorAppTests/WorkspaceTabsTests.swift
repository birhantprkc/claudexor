import Testing
@testable import ClaudexorApp

/// Thread-workspace tabs (Changes / Artifacts / Evidence / remote Terminal) +
/// the default + no-auto-jump-after-manual-selection guard.
@Suite struct WorkspaceTabsTests {
    @Test func evidenceHydrationIsIdentityKeyedAndFailedLoadsRemainRetryable() {
        #expect(RunEvidenceSection.needsDetailLoad(
            runId: "run-b", loadedRunId: "run-a", hydrated: true))
        #expect(RunEvidenceSection.needsDetailLoad(
            runId: "run-b", loadedRunId: nil, hydrated: false))
        #expect(!RunEvidenceSection.needsDetailLoad(
            runId: "run-b", loadedRunId: "run-b", hydrated: true))
    }

    private func inputs(runSelected: Bool = false, failedNoOutput: Bool = false) -> WorkspaceTabInputs {
        WorkspaceTabInputs(runSelected: runSelected, selectedRunFailedNoOutput: failedNoOutput)
    }

    @Test func exactlyFourTabsIncludingRemoteTerminal() {
        #expect(WorkspaceTab.allCases == [.changes, .artifacts, .evidence, .terminal])
    }

    @Test func wholeThreadDefaultsToChanges() {
        #expect(WorkspaceTabPolicy.defaultTab(inputs()) == .changes)
    }

    @Test func selectedRunWithOutputDefaultsToChanges() {
        #expect(WorkspaceTabPolicy.defaultTab(inputs(runSelected: true, failedNoOutput: false)) == .changes)
    }

    @Test func selectedRunFailedNoOutputDefaultsToEvidence() {
        // A failure-shaped run with no primary output: its diagnostics ARE the
        // deliverable, so open Evidence.
        #expect(WorkspaceTabPolicy.defaultTab(inputs(runSelected: true, failedNoOutput: true)) == .evidence)
    }

    @Test func failedNoOutputWithoutSelectionStaysChanges() {
        // Only meaningful when a receipt is selected; the whole-thread view never
        // opens on Evidence just because some run failed.
        #expect(WorkspaceTabPolicy.defaultTab(inputs(runSelected: false, failedNoOutput: true)) == .changes)
    }

    @Test func noJumpAfterManualSelection() {
        // The user parked on Artifacts; the filter then changes. Resolve must keep
        // them on Artifacts rather than yanking to the new default.
        let resolved = WorkspaceTabPolicy.resolve(
            current: .artifacts, userSelected: true,
            inputs: inputs(runSelected: true, failedNoOutput: true))
        #expect(resolved == .artifacts)
    }

    @Test func tracksDefaultUntilManualSelection() {
        let whole = WorkspaceTabPolicy.resolve(current: .evidence, userSelected: false, inputs: inputs())
        #expect(whole == .changes)
        let failed = WorkspaceTabPolicy.resolve(
            current: .changes, userSelected: false,
            inputs: inputs(runSelected: true, failedNoOutput: true))
        #expect(failed == .evidence)
    }

    @Test func remoteOnlyTerminalResetsWhenLocalThreadIsSelected() {
        #expect(WorkspaceTabPolicy.validated(
            current: .terminal,
            available: [.changes, .artifacts, .evidence]) == .changes)
        #expect(WorkspaceTabPolicy.validated(
            current: .terminal,
            available: [.changes, .artifacts, .evidence, .terminal]) == .terminal)
    }
}
