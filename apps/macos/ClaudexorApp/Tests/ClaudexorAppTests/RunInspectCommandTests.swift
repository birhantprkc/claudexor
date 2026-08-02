import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RunInspectCommandTests {
    @Test func resolvedRunIDReplacesTheStableQueuedJobAlias() {
        #expect(RunInspectCommand.diagnosticRunID(
            stableID: "job-queued", resolvedRunID: "run-real") == "run-real")
        #expect(RunInspectCommand.diagnosticRunID(
            stableID: "run-stable", resolvedRunID: nil) == "run-stable")
    }

    @Test func localCommandQuotesBundledPathsAndTheFullRunID() {
        let command = RunInspectCommand.local(
            runID: "run-e3decb11d1e4",
            node: URL(fileURLWithPath: "/Applications/Claudexor App/node"),
            cli: URL(fileURLWithPath: "/Applications/Claudexor App/claudexor.bundle.cjs"))
        #expect(command == "'/Applications/Claudexor App/node' '/Applications/Claudexor App/claudexor.bundle.cjs' 'inspect' 'run-e3decb11d1e4'")
        #expect(!command.contains("'11d1e4'"))
    }

    @Test func remoteCommandUsesThePinnedRemoteRuntimeAndFullRunID() {
        #expect(RunInspectCommand.remote(runID: "run-full")
            == "~/.claudexor/remote/current/bin/claudexor inspect 'run-full'")
    }

    @Test func developmentBuildWithoutBundledAssetsDoesNotInventAPathCommand() {
        #expect(RunInspectCommand.availableLocal(
            runID: "run-full",
            node: nil,
            cli: nil) == nil)
    }
}
