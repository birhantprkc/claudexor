import Foundation

public struct SSHInvocation: Sendable, Equatable {
    public let executable: String
    public let arguments: [String]

    public init(executable: String = "/usr/bin/ssh", arguments: [String]) {
        self.executable = executable
        self.arguments = arguments
    }
}

public struct SSHCommandFactory: Sendable {
    // Darwin's sockaddr_un.sun_path holds 104 bytes including its trailing NUL.
    // Refuse an unusable ControlPath before OpenSSH falls through to a misleading
    // authentication prompt. Count UTF-8 bytes, not Swift characters.
    static let maximumControlPathByteCount = 103

    public let alias: String
    public let controlPath: String

    public init(alias: String, controlPath: String) throws {
        guard SSHConfigScanner.isConcreteAlias(alias) else {
            throw SSHConfigError.invalidAlias(alias)
        }
        guard controlPath.hasPrefix("/"), !controlPath.contains("\0") else {
            throw SSHConfigError.resolutionFailed("ControlPath must be an absolute path")
        }
        guard controlPath.utf8.count <= Self.maximumControlPathByteCount else {
            throw SSHConfigError.resolutionFailed(
                "ControlPath is too long for a Unix domain socket")
        }
        self.alias = alias
        self.controlPath = controlPath
    }

    private var socketOption: [String] { ["-o", "ControlPath=\(controlPath)"] }

    public func startMaster(batchMode: Bool) -> SSHInvocation {
        var arguments = [
            "-M", "-N", "-f",
            "-o", "ControlMaster=yes",
            // The app owns this master and explicitly closes it during shutdown.
            // A numeric idle timeout silently destroys Control API/preview
            // forwards while the UI still has a live in-memory client.
            "-o", "ControlPersist=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
        ] + socketOption
        if batchMode { arguments += ["-o", "BatchMode=yes"] }
        arguments.append(alias)
        return SSHInvocation(arguments: arguments)
    }

    public func checkMaster() -> SSHInvocation {
        SSHInvocation(arguments: ["-S", controlPath, "-O", "check", alias])
    }

    public func stopMaster() -> SSHInvocation {
        SSHInvocation(arguments: ["-S", controlPath, "-O", "exit", alias])
    }

    public func remoteCommand(
        _ command: String,
        requestTTY: Bool = false
    ) -> SSHInvocation {
        SSHInvocation(arguments:
            ["-S", controlPath, "-o", "ControlMaster=no"]
            + (requestTTY ? ["-tt"] : [])
            + [alias, command])
    }

    public func forward(localPort: Int, remotePort: Int) -> SSHInvocation {
        SSHInvocation(arguments: [
            "-S", controlPath, "-O", "forward",
            "-L", "127.0.0.1:\(localPort):127.0.0.1:\(remotePort)",
            alias,
        ])
    }

    public func cancelForward(localPort: Int, remotePort: Int) -> SSHInvocation {
        SSHInvocation(arguments: [
            "-S", controlPath, "-O", "cancel",
            "-L", "127.0.0.1:\(localPort):127.0.0.1:\(remotePort)",
            alias,
        ])
    }

    public func shell(in remoteDirectory: String) -> SSHInvocation {
        remoteCommand(
            "cd -- \(Self.posixQuote(remoteDirectory)) && exec \"${SHELL:-/bin/sh}\" -l")
    }

    public func setupAttach(jobID: String) throws -> SSHInvocation {
        guard jobID.hasPrefix("setup-"),
              jobID.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" })
        else { throw SSHConfigError.resolutionFailed("invalid setup job id") }
        return remoteCommand(
            "~/.claudexor/remote/current/bin/claudexor setup attach \(jobID)")
    }

    /// POSIX single-quote encoding for the remote login shell. The local app
    /// never invokes a shell; this string is the SSH remote-command protocol.
    public static func posixQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }
}
