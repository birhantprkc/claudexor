import ClaudexorKit
import Foundation

/// Exact recovery command copied by the run Evidence surface. Compact run
/// labels remain presentation-only; every command carries the full id.
enum RunInspectCommand {
    static func diagnosticRunID(stableID: String, resolvedRunID: String?) -> String {
        resolvedRunID ?? stableID
    }

    static func local(runID: String, node: URL, cli: URL) -> String {
        [node.path, cli.path, "inspect", runID]
            .map(SSHCommandFactory.posixQuote)
            .joined(separator: " ")
    }

    static func availableLocal(
        runID: String,
        node: URL? = DaemonLauncher.bundledNode,
        cli: URL? = DaemonLauncher.bundledCLI,
        fileManager: FileManager = .default
    ) -> String? {
        guard let node, let cli,
              fileManager.isExecutableFile(atPath: node.path),
              fileManager.fileExists(atPath: cli.path)
        else { return nil }
        return local(runID: runID, node: node, cli: cli)
    }

    static func remote(runID: String) -> String {
        "~/.claudexor/remote/current/bin/claudexor inspect "
            + SSHCommandFactory.posixQuote(runID)
    }

    static func command(runID: String, locationID: ExecutionLocationID) -> String? {
        locationID == .local
            ? availableLocal(runID: runID)
            : remote(runID: runID)
    }
}
