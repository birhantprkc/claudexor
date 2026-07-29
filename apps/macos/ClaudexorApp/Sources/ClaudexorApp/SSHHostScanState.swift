import ClaudexorKit
import Foundation

// MARK: - Typed ~/.ssh/config scan outcome (fail-loud, INV: no silent collapse)

/// What scanning `~/.ssh/config` actually found. Replaces the old
/// `try?`-to-empty-array collapse, which made four different truths render
/// identically — and let the disabled-picker help text claim "every alias is
/// already added" when the config was missing or the scan had failed.
enum SSHHostScanState: Equatable {
    /// The config file does not exist yet.
    case configMissing
    /// The config exists but declares no concrete (non-pattern) Host aliases.
    case noConcreteAliases
    /// Concrete aliases were found (may still all be added already).
    case hosts([SSHHost])
    /// Reading or parsing the config failed — the reason is user-facing.
    case scanFailed(String)

    var hosts: [SSHHost] {
        if case let .hosts(list) = self { return list }
        return []
    }

    /// The ONE scan owner (startup + Rescan + post-write all come through
    /// here), so no call site can reintroduce the `try?` collapse.
    static func scan(path: String = "~/.ssh/config") -> SSHHostScanState {
        let expanded = NSString(string: path).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: expanded) else { return .configMissing }
        do {
            let hosts = try SSHConfigScanner().scan(path: path)
            return hosts.isEmpty ? .noConcreteAliases : .hosts(hosts)
        } catch {
            return .scanFailed(error.localizedDescription)
        }
    }
}

// MARK: - Picker copy per state (the help text must tell the real state)

/// What the Connections "From config" picker row says in each scan state.
/// Pure so the four-state copy is unit-tested; the view renders it verbatim.
struct SSHHostPickerPresentation: Equatable {
    /// Aliases that can still become connections (empty in every degraded state).
    let addable: [SSHHost]
    /// The disabled/placeholder first picker entry.
    let placeholder: String
    /// Hover help for the disabled Add control — states WHY it is disabled.
    let help: String
    /// Non-nil only when the scan failed: shown inline (a failed scan is a
    /// visible error, not just a quieter picker).
    let inlineFailure: String?

    static func present(
        scan: SSHHostScanState, addedAliases: Set<String>
    ) -> SSHHostPickerPresentation {
        switch scan {
        case .configMissing:
            return SSHHostPickerPresentation(
                addable: [],
                placeholder: "No config file yet",
                help: "~/.ssh/config does not exist yet. Create your first host with “New SSH Host…”, or write the file yourself and press Rescan.",
                inlineFailure: nil)
        case .noConcreteAliases:
            return SSHHostPickerPresentation(
                addable: [],
                placeholder: "No concrete Host aliases found",
                help: "~/.ssh/config declares no concrete Host aliases — pattern (wildcard) hosts cannot become connections. Create one with “New SSH Host…”.",
                inlineFailure: nil)
        case let .scanFailed(reason):
            return SSHHostPickerPresentation(
                addable: [],
                placeholder: "Could not read ~/.ssh/config",
                help: "Reading ~/.ssh/config failed. Fix the file and press Rescan.",
                inlineFailure: "Could not read ~/.ssh/config: \(reason)")
        case let .hosts(hosts):
            let addable = hosts.filter { !addedAliases.contains($0.alias) }
            if addable.isEmpty {
                return SSHHostPickerPresentation(
                    addable: [],
                    placeholder: "Every alias already added",
                    help: "Every concrete Host alias in ~/.ssh/config is already added as a connection.",
                    inlineFailure: nil)
            }
            return SSHHostPickerPresentation(
                addable: addable,
                placeholder: "Choose an alias",
                help: "Choose an alias first, then add it as an execution location.",
                inlineFailure: nil)
        }
    }
}

// MARK: - Post-creation receipt (filesystem transparency)

/// The dismissible receipt Connections shows after "Create & Add": which file
/// was written, whether a backup existed, and whether the app connection was
/// actually added. Presentation lines are derived here (pure, tested) so the
/// receipt can NEVER claim a backup that was not made, and a written-but-not-
/// added partial outcome is reported explicitly instead of lost.
struct SSHHostCreationReceipt: Equatable {
    let alias: String
    let configPath: String
    let backupPath: String?
    let createdConfig: Bool
    /// The exact appended block (writer-owned bytes) for "Copy Block".
    let appendedBlock: String
    /// nil = the connection was added; non-nil = the write succeeded but
    /// adding the connection failed for this reason (partial outcome).
    let connectionFailure: String?

    var headline: String {
        connectionFailure == nil
            ? "Added “\(alias)” to Connections"
            : "Wrote the “\(alias)” host block, but the connection was not added"
    }

    var detailLines: [String] {
        var lines = ["Wrote: \(configPath)"]
        if createdConfig {
            // Never claim a backup existed when the file was just created.
            lines.append("Created a new config; there was no previous file to back up.")
        } else if let backupPath {
            lines.append("Backup: \(backupPath)")
        }
        if let connectionFailure {
            lines.append("\(connectionFailure) Use the “From config” picker to add it once resolvable.")
        }
        return lines
    }
}
