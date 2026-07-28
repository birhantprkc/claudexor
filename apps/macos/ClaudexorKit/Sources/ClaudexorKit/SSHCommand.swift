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
        if batchMode {
            // LogLevel=ERROR keeps OpenSSH's own error()/fatal() diagnostics
            // (Permission denied, Host key verification failed, the
            // changed-host-key warning) and suppresses the INFO-level display
            // of the server's pre-auth banner. That narrows server-controlled
            // stderr but does NOT eliminate it: a hostile server still reaches
            // ERROR level through the SSH_MSG_DISCONNECT text ("Received
            // disconnect from …: <server bytes>"), the bad-protocol-version
            // echo, and banner-exchange failures. The batch stderr sniffer
            // (sshBatchFailureNeedsInteraction) therefore drops those
            // server-echo line families before matching.
            arguments += ["-o", "BatchMode=yes", "-o", "LogLevel=ERROR"]
        }
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
        // Plain exec commands (the default) ride the app-owned control master
        // with nobody watching an ssh prompt. If the master has died, OpenSSH
        // would fall back to a fresh connection and could block on (or
        // misbind) an authentication/host-key prompt, so refuse it with
        // BatchMode; LogLevel=ERROR trims INFO chatter from the stderr that
        // surfaces in app error messages (it is not a complete fence against
        // server-authored bytes — see sshBatchFailureNeedsInteraction). Fresh
        // authentication belongs to the interactive master path
        // (startMaster(batchMode: false) in a real terminal).
        //
        // Interactive commands (requestTTY: true) render inside the app's
        // SwiftTerm sheet where a person IS watching: `-tt` forces a remote
        // PTY (with a remote command, ssh's `RequestTTY auto` would NOT
        // allocate one), which interactive vendor logins and a usable remote
        // shell require, and BatchMode must NEVER apply — a key-passphrase or
        // login prompt shown in that sheet must be answerable.
        SSHInvocation(arguments:
            ["-S", controlPath, "-o", "ControlMaster=no"]
            + (requestTTY ? ["-tt"] : ["-o", "BatchMode=yes", "-o", "LogLevel=ERROR"])
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

    /// Interactive: feeds the visible SwiftTerm sheet, so the remote shell
    /// needs a real PTY (prompt, job control, raw mode) and prompts must be
    /// answerable — never BatchMode here.
    public func shell(in remoteDirectory: String) -> SSHInvocation {
        remoteCommand(
            "cd -- \(Self.posixQuote(remoteDirectory)) && exec \"${SHELL:-/bin/sh}\" -l",
            requestTTY: true)
    }

    /// Interactive: the client_pty transport is the ONLY remote harness-login
    /// path; vendor logins (claude/cursor) need raw-mode terminal input, so a
    /// remote PTY is mandatory and BatchMode must never apply.
    public func setupAttach(jobID: String) throws -> SSHInvocation {
        guard jobID.hasPrefix("setup-"),
              jobID.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" })
        else { throw SSHConfigError.resolutionFailed("invalid setup job id") }
        // The allowlist above is the real fence; the quote keeps the
        // "every interpolation is posixQuoted" invariant machine-checkable.
        return remoteCommand(
            "~/.claudexor/remote/current/bin/claudexor setup attach "
                + Self.posixQuote(jobID),
            requestTTY: true)
    }

    /// POSIX single-quote encoding for the remote login shell. The local app
    /// never invokes a shell; this string is the SSH remote-command protocol.
    public static func posixQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }
}
