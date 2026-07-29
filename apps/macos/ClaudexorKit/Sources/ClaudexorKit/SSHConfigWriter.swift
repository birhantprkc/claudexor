import Foundation

/// A new `Host` block as the user typed it in the form. Every field is raw
/// text; the writer trims, validates, and refuses before it touches the file.
/// Empty optional fields simply emit no directive.
public struct SSHHostDraft: Sendable, Equatable {
    public var alias: String
    public var hostName: String
    public var user: String
    public var port: String
    public var identityFile: String

    public init(
        alias: String = "",
        hostName: String = "",
        user: String = "",
        port: String = "",
        identityFile: String = ""
    ) {
        self.alias = alias
        self.hostName = hostName
        self.user = user
        self.port = port
        self.identityFile = identityFile
    }
}

public enum SSHConfigWriteError: Error, LocalizedError, Equatable {
    case invalidAlias(String)
    case duplicateAlias(String, existingSource: String)
    case emptyHostName
    case unsafeValue(field: String)
    case invalidPort(String)
    case writeFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidAlias(alias):
            "'\(alias)' cannot be a Host alias. Use one word without spaces or wildcards."
        case let .duplicateAlias(alias, existingSource):
            "Host '\(alias)' already exists in \(existingSource). Pick another alias, or press Rescan to use the existing one."
        case .emptyHostName:
            "Host name is required."
        case let .unsafeValue(field):
            "\(field) must be a single line without control or quote characters."
        case let .invalidPort(port):
            "Port '\(port)' must be a whole number between 1 and 65535."
        case let .writeFailed(detail):
            "Could not write ~/.ssh/config: \(detail)"
        }
    }
}

/// Appends a user-authored `Host` block to `~/.ssh/config` — exactly what the
/// user would type into a text editor, nothing more. Claudexor still never
/// stores keys, passwords, or tokens; authentication stays with /usr/bin/ssh.
///
/// Fences (all typed refusals, never silent):
/// - a duplicate alias anywhere in the reachable config (Includes count);
/// - a pattern/option-shaped alias (`SSHConfigScanner.isConcreteAlias`);
/// - any multi-line or control-character value (a newline would forge extra
///   directives — this is an injection fence, not pedantry);
/// - a port outside 1...65535.
///
/// File discipline: append-only after a timestamped backup; `~/.ssh` is
/// created 0700 and the config 0600 only when absent — the mode of an
/// existing file is never touched, let alone widened.
public struct SSHConfigWriter: Sendable {
    public struct Receipt: Sendable, Equatable {
        public let alias: String
        public let configPath: String
        /// Where the pre-write copy went; nil when the config was just created.
        public let backupPath: String?
    }

    private let scanner: SSHConfigScanner
    private let now: @Sendable () -> Date

    public init(scanner: SSHConfigScanner = SSHConfigScanner(), now: (@Sendable () -> Date)? = nil) {
        self.scanner = scanner
        self.now = now ?? { Date() }
    }

    @discardableResult
    public func appendHost(
        _ draft: SSHHostDraft,
        toConfigAt path: String = "~/.ssh/config"
    ) throws -> Receipt {
        let alias = trimmed(draft.alias)
        let hostName = trimmed(draft.hostName)
        let user = trimmed(draft.user)
        let port = trimmed(draft.port)
        let identityFile = trimmed(draft.identityFile)

        guard SSHConfigScanner.isConcreteAlias(alias), Self.isPlainToken(alias) else {
            throw SSHConfigWriteError.invalidAlias(alias)
        }
        guard !hostName.isEmpty else { throw SSHConfigWriteError.emptyHostName }
        guard Self.isPlainToken(hostName) else {
            throw SSHConfigWriteError.unsafeValue(field: "Host name")
        }
        guard user.isEmpty || Self.isPlainToken(user) else {
            throw SSHConfigWriteError.unsafeValue(field: "User")
        }
        var portNumber: Int?
        if !port.isEmpty {
            guard let value = Int(port), (1 ... 65_535).contains(value) else {
                throw SSHConfigWriteError.invalidPort(port)
            }
            portNumber = value
        }
        guard identityFile.isEmpty || Self.isPlainToken(identityFile, allowingSpaces: true) else {
            throw SSHConfigWriteError.unsafeValue(field: "Identity file")
        }

        let configPath = NSString(string: path).expandingTildeInPath
        let manager = FileManager.default
        let configExists = manager.fileExists(atPath: configPath)
        if configExists {
            // The scanner follows Include, so an alias defined in any reachable
            // file refuses the write — never a silent duplicate or overwrite.
            let hosts = try scanner.scan(path: configPath)
            if let existing = hosts.first(where: { $0.alias == alias }) {
                throw SSHConfigWriteError.duplicateAlias(
                    alias, existingSource: existing.sourcePath)
            }
        }

        var block = ""
        var backupPath: String?
        do {
            if configExists {
                let existing = try String(contentsOfFile: configPath, encoding: .utf8)
                backupPath = try backUp(configPath, manager: manager)
                if !existing.isEmpty {
                    if !existing.hasSuffix("\n") { block += "\n" }
                    block += "\n"
                }
            } else {
                let directory = (configPath as NSString).deletingLastPathComponent
                if !manager.fileExists(atPath: directory) {
                    try manager.createDirectory(
                        atPath: directory,
                        withIntermediateDirectories: true,
                        attributes: [.posixPermissions: 0o700])
                }
                guard
                    manager.createFile(
                        atPath: configPath,
                        contents: Data(),
                        attributes: [.posixPermissions: 0o600])
                else {
                    throw SSHConfigWriteError.writeFailed("could not create \(configPath)")
                }
            }
            block += "# Added by Claudexor on \(dayStamp(now()))\n"
            block += "Host \(alias)\n"
            block += "  HostName \(hostName)\n"
            if !user.isEmpty { block += "  User \(user)\n" }
            if let portNumber { block += "  Port \(portNumber)\n" }
            if !identityFile.isEmpty {
                let value = identityFile.contains(" ") ? "\"\(identityFile)\"" : identityFile
                block += "  IdentityFile \(value)\n"
            }
            // Appending through a handle never rewrites, reorders, or re-modes
            // the user's existing bytes.
            guard let handle = FileHandle(forWritingAtPath: configPath) else {
                throw SSHConfigWriteError.writeFailed("could not open \(configPath) for appending")
            }
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(block.utf8))
        } catch let error as SSHConfigWriteError {
            throw error
        } catch {
            throw SSHConfigWriteError.writeFailed(error.localizedDescription)
        }
        return Receipt(alias: alias, configPath: configPath, backupPath: backupPath)
    }

    private func backUp(_ configPath: String, manager: FileManager) throws -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let base = "\(configPath).claudexor-backup-\(formatter.string(from: now()))"
        var candidate = base
        var counter = 2
        while manager.fileExists(atPath: candidate) {
            candidate = "\(base)-\(counter)"
            counter += 1
        }
        try manager.copyItem(atPath: configPath, toPath: candidate)
        return candidate
    }

    private func dayStamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One safe single-line token, guaranteed to survive both OpenSSH's parser
    /// and `SSHConfigScanner.words(in:)` unchanged: no control characters
    /// (newline injection would forge extra directives), no comment/quote/escape
    /// metacharacters, and no spaces unless the caller quotes the value.
    static func isPlainToken(_ value: String, allowingSpaces: Bool = false) -> Bool {
        guard !value.isEmpty else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            if scalar.value < 0x20 || scalar.value == 0x7F { return false }
            if "#\"'\\".unicodeScalars.contains(scalar) { return false }
            if scalar == " " { return allowingSpaces }
            return true
        }
    }
}
