import Testing
@testable import ClaudexorKit

@Suite struct ComposerOptionParserEdgeTests {
    @Test func terminalLineEndingsAreLayoutNotEmptyReviewers() {
        #expect(ComposerOptionParser.splitOptionTokens("codex:low\n") == ["codex:low"])
        #expect(ComposerOptionParser.splitOptionTokens("codex:low\r\n") == ["codex:low"])
        #expect(ComposerOptionParser.splitOptionTokens("codex:low\n\n") == ["codex:low"])
    }

    @Test func interiorEmptyRowsAndTrailingCommasRemainDiagnostics() {
        #expect(ComposerOptionParser.splitOptionTokens("codex\n\nclaude") == ["codex", "", "claude"])
        #expect(ComposerOptionParser.splitOptionTokens("codex\r\n\r\nclaude") == ["codex", "", "claude"])
        #expect(ComposerOptionParser.splitOptionTokens("codex\r\rclaude") == ["codex", "", "claude"])
        #expect(ComposerOptionParser.splitOptionTokens("codex,") == ["codex", ""])
    }
}
