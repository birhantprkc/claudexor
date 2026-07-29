import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite struct GitReadinessPresentationTests {
    @Test func keepsWorkspaceGitSeparateFromHarnessReadiness() {
        let missing = GitReadinessPresentation.from(
            capability: WorkspaceGitCapability(
                status: "developer_tools_stub",
                version: nil,
                detail: "xcode-select could not find developer tools",
                remediation: "Run xcode-select --install."),
            readinessFresh: true)
        #expect(missing.title == "Workspace Git")
        #expect(missing.status == "Developer tools required")
        #expect(missing.detail.contains("xcode-select"))
        #expect(missing.remediation == "Run xcode-select --install.")
        #expect(missing.tone == .warn)

        let ready = GitReadinessPresentation.from(
            capability: WorkspaceGitCapability(
                status: "available",
                version: "git version 2.51.0",
                detail: nil,
                remediation: nil),
            readinessFresh: true)
        #expect(ready.title == "Workspace Git")
        #expect(ready.status == "Available")
        #expect(ready.detail == "git version 2.51.0")
        #expect(ready.remediation == nil)
        #expect(ready.tone == .positive)
    }

    @Test func staleOrMissingProjectionNeverClaimsGitIsReady() {
        let stale = GitReadinessPresentation.from(capability: nil, readinessFresh: false)
        #expect(stale.title == "Workspace Git")
        #expect(stale.status == "Unknown")
        #expect(stale.tone == .neutral)
    }
}
