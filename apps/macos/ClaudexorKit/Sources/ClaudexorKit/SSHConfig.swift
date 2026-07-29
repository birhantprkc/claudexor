import Foundation
#if canImport(Darwin)
import Darwin
#endif

public struct SSHHost: Sendable, Identifiable, Equatable {
    public let alias: String
    public let sourcePath: String

    public init(alias: String, sourcePath: String) {
        self.alias = alias
        self.sourcePath = sourcePath
    }

    public var id: String { alias }
}

public struct EffectiveSSHConfiguration: Sendable, Equatable {
    public let alias: String
    public let hostname: String
    public let user: String?
    public let port: Int
    public let proxyJump: String?
    public let values: [String: String]
}

public enum SSHConfigError: Error, LocalizedError, Equatable {
    case unreadable(String)
    case includeDepthExceeded
    case invalidAlias(String)
    case resolutionFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .unreadable(path): "Could not read SSH config at \(path)."
        case .includeDepthExceeded: "SSH config Include nesting is too deep."
        case let .invalidAlias(alias): "Unsafe SSH alias '\(alias)'."
        case let .resolutionFailed(detail): "OpenSSH could not resolve the host: \(detail)"
        }
    }
}

/// Discovery parser only. OpenSSH remains authoritative for option semantics;
/// every selected alias is resolved again with `/usr/bin/ssh -G`.
public struct SSHConfigScanner: Sendable {
    public typealias ReadFile = @Sendable (String) throws -> String
    public typealias ExpandIncludes = @Sendable (_ pattern: String, _ sourcePath: String) -> [String]

    private let readFile: ReadFile
    private let expandIncludes: ExpandIncludes

    public init(
        readFile: ReadFile? = nil,
        expandIncludes: ExpandIncludes? = nil
    ) {
        self.readFile = readFile ?? { try String(contentsOfFile: $0, encoding: .utf8) }
        self.expandIncludes = expandIncludes ?? SSHConfigScanner.expandIncludePattern
    }

    public func scan(path: String) throws -> [SSHHost] {
        try scan(path: path, rootContents: nil)
    }

    /// Scan one already-open root snapshot while preserving the ordinary
    /// Include reader. The writer uses this overload so duplicate validation
    /// and the later append concern the same root inode and bytes.
    func scan(path: String, rootContents: String) throws -> [SSHHost] {
        try scan(path: path, rootContents: Optional(rootContents))
    }

    private func scan(path: String, rootContents: String?) throws -> [SSHHost] {
        var visited = Set<String>()
        var discovered = [String: SSHHost]()
        let rootPath = URL(fileURLWithPath: Self.normalized(path)).standardizedFileURL.path
        try scanFile(
            path: rootPath,
            depth: 0,
            rootSnapshot: rootContents.map { (rootPath, $0) },
            visited: &visited,
            output: &discovered)
        return discovered.values.sorted {
            $0.alias.localizedCaseInsensitiveCompare($1.alias) == .orderedAscending
        }
    }

    private func scanFile(
        path: String,
        depth: Int,
        rootSnapshot: (path: String, contents: String)?,
        visited: inout Set<String>,
        output: inout [String: SSHHost]
    ) throws {
        guard depth <= 32 else { throw SSHConfigError.includeDepthExceeded }
        let canonical = URL(fileURLWithPath: path).standardizedFileURL.path
        guard visited.insert(canonical).inserted else { return }
        let contents: String
        if let rootSnapshot, canonical == rootSnapshot.path {
            contents = rootSnapshot.contents
        } else {
            do {
                contents = try readFile(canonical)
            } catch {
                if depth == 0 { throw SSHConfigError.unreadable(canonical) }
                return
            }
        }
        for line in contents.split(whereSeparator: \.isNewline) {
            let words = Self.words(in: String(line))
            guard let keyword = words.first?.lowercased() else { continue }
            if keyword == "include" {
                for pattern in words.dropFirst() {
                    for includePath in expandIncludes(pattern, canonical) {
                        try scanFile(
                            path: includePath,
                            depth: depth + 1,
                            rootSnapshot: rootSnapshot,
                            visited: &visited,
                            output: &output)
                    }
                }
            } else if keyword == "host" {
                for alias in words.dropFirst() where Self.isConcreteAlias(alias) {
                    output[alias] = output[alias] ?? SSHHost(alias: alias, sourcePath: canonical)
                }
            }
        }
    }

    public static func isConcreteAlias(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("-"), !value.hasPrefix("!") else { return false }
        return !value.contains { "*?[]".contains($0) }
    }

    static func words(in rawLine: String) -> [String] {
        var result = [String]()
        var current = ""
        var quote: Character?
        var escaped = false
        for character in rawLine {
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if let activeQuote = quote {
                if character == activeQuote { quote = nil } else { current.append(character) }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "#" {
                break
            } else if character.isWhitespace {
                if !current.isEmpty {
                    result.append(current)
                    current = ""
                }
            } else {
                current.append(character)
            }
        }
        if escaped { current.append("\\") }
        if !current.isEmpty { result.append(current) }
        return result
    }

    private static func normalized(_ path: String) -> String {
        NSString(string: path).expandingTildeInPath
    }

    static func expandIncludePattern(_ pattern: String, sourcePath: String) -> [String] {
        let expanded = NSString(string: pattern).expandingTildeInPath
        let absolute: String
        if expanded.hasPrefix("/") {
            absolute = expanded
        } else {
            // OpenSSH resolves relative user-config Includes from ~/.ssh.
            let userSSH = NSString(string: "~/.ssh").expandingTildeInPath
            absolute = URL(fileURLWithPath: userSSH).appendingPathComponent(expanded).path
        }
        #if canImport(Darwin)
        var matches = glob_t()
        defer { globfree(&matches) }
        guard glob(absolute, 0, nil, &matches) == 0, let paths = matches.gl_pathv else {
            return []
        }
        return (0 ..< Int(matches.gl_pathc)).compactMap { index in
            paths[index].map { String(cString: $0) }
        }.sorted()
        #else
        return FileManager.default.fileExists(atPath: absolute) ? [absolute] : []
        #endif
    }
}

public struct OpenSSHResolver: Sendable {
    public typealias Runner = @Sendable (_ executable: String, _ arguments: [String]) throws -> Data
    private let runner: Runner

    public init(runner: Runner? = nil) {
        self.runner = runner ?? OpenSSHResolver.run
    }

    public func resolve(alias: String) throws -> EffectiveSSHConfiguration {
        guard SSHConfigScanner.isConcreteAlias(alias) else {
            throw SSHConfigError.invalidAlias(alias)
        }
        let data: Data
        do {
            data = try runner("/usr/bin/ssh", ["-G", alias])
        } catch {
            throw SSHConfigError.resolutionFailed(error.localizedDescription)
        }
        guard let output = String(data: data, encoding: .utf8) else {
            throw SSHConfigError.resolutionFailed("ssh -G returned non-UTF-8 output")
        }
        var values = [String: String]()
        for line in output.split(whereSeparator: \.isNewline) {
            let pieces = line.split(maxSplits: 1, whereSeparator: \.isWhitespace)
            guard pieces.count == 2 else { continue }
            values[String(pieces[0]).lowercased()] = String(pieces[1])
        }
        guard let hostname = values["hostname"], !hostname.isEmpty else {
            throw SSHConfigError.resolutionFailed("ssh -G omitted hostname")
        }
        let port = Int(values["port"] ?? "") ?? 22
        guard (1 ... 65_535).contains(port) else {
            throw SSHConfigError.resolutionFailed("ssh -G returned an invalid port")
        }
        return EffectiveSSHConfiguration(
            alias: alias,
            hostname: hostname,
            user: values["user"],
            port: port,
            proxyJump: values["proxyjump"].flatMap { $0 == "none" ? nil : $0 },
            values: values)
    }

    private static func run(_ executable: String, _ arguments: [String]) throws -> Data {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        if process.terminationStatus != 0 {
            let detail = String(
                data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw SSHConfigError.resolutionFailed(detail)
        }
        return data
    }
}
