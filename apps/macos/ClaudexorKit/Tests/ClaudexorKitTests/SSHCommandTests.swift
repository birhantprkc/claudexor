import Testing
@testable import ClaudexorKit

@Suite struct SSHCommandTests {
    @Test func everyInvocationUsesTheAppOwnedControlSocket() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let master = factory.startMaster(batchMode: true)
        #expect(master.executable == "/usr/bin/ssh")
        #expect(master.arguments.contains("BatchMode=yes"))
        #expect(master.arguments.contains("ControlPersist=yes"))
        #expect(!master.arguments.contains("ControlPersist=600"))
        #expect(master.arguments.contains("ServerAliveInterval=30"))
        #expect(master.arguments.contains("ServerAliveCountMax=3"))
        #expect(factory.remoteCommand("true").arguments == [
            "-S", "/tmp/cx/master", "-o", "ControlMaster=no",
            "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
            "prod", "true",
        ])
        #expect(factory.forward(localPort: 4400, remotePort: 3000).arguments.contains(
            "127.0.0.1:4400:127.0.0.1:3000"))
    }

    @Test func nonPTYCommandsRefusePromptsButPTYCommandsKeepThem() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let pty = factory.remoteCommand("tail -f log", requestTTY: true).arguments
        #expect(pty == [
            "-S", "/tmp/cx/master", "-o", "ControlMaster=no", "-tt", "prod", "tail -f log",
        ])
        #expect(!pty.contains("BatchMode=yes"))
        #expect(!pty.contains("LogLevel=ERROR"))
    }

    @Test func batchMasterSuppressesServerBannerButInteractiveMasterDoesNot() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let batch = factory.startMaster(batchMode: true).arguments
        // The banner-spoof fence: the stderr that connectBatch sniffs for
        // "needs interaction" must only ever contain OpenSSH's own
        // error()/fatal() text, never a server-authored pre-auth banner.
        #expect(batch.contains("LogLevel=ERROR"))
        let interactive = factory.startMaster(batchMode: false).arguments
        #expect(!interactive.contains("BatchMode=yes"))
        #expect(!interactive.contains("LogLevel=ERROR"))
    }

    @Test func setupAttachQuotesTheValidatedJobID() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let command = try #require(factory.setupAttach(jobID: "setup-ab12").arguments.last)
        #expect(command
            == "~/.claudexor/remote/current/bin/claudexor setup attach 'setup-ab12'")
        #expect(throws: SSHConfigError.self) {
            _ = try factory.setupAttach(jobID: "setup-a;rm -rf ~")
        }
        #expect(throws: SSHConfigError.self) {
            _ = try factory.setupAttach(jobID: "prod-ab12")
        }
    }

    @Test func remoteDirectoryIsQuotedWithoutLocalShellInterpolation() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let command = try #require(factory.shell(in: "/srv/it's app").arguments.last)
        #expect(command == "cd -- '/srv/it'\"'\"'s app' && exec \"${SHELL:-/bin/sh}\" -l")
    }

    // The two interactive builders feed a visible SwiftTerm sheet: without a
    // remote PTY the shell has no prompt/job control and a raw-mode vendor
    // login (claude/cursor via setup attach) cannot work, and with BatchMode a
    // key-passphrase prompt shown in that sheet would be refused instead of
    // answered. A remote command suppresses ssh's `RequestTTY auto`, so the
    // TTY must be requested explicitly.
    @Test func interactiveShellAndSetupAttachRequestATTYAndNeverBatchMode() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let shell = factory.shell(in: "/srv/app").arguments
        let attach = try factory.setupAttach(jobID: "setup-ab12").arguments
        for arguments in [shell, attach] {
            #expect(arguments.contains("-tt"))
            #expect(!arguments.contains("BatchMode=yes"))
            #expect(!arguments.contains("LogLevel=ERROR"))
        }
        // Genuinely non-interactive exec keeps refusing prompts.
        let exec = factory.remoteCommand("true").arguments
        #expect(exec.contains("BatchMode=yes"))
        #expect(!exec.contains("-tt"))
    }

    @Test func optionLikeHostIsRejected() {
        #expect(throws: SSHConfigError.self) {
            _ = try SSHCommandFactory(
                alias: "-oProxyCommand=touch /tmp/pwned", controlPath: "/tmp/cx/master")
        }
    }

    @Test func overlongDarwinControlPathIsRejectedBeforeOpenSSHLaunch() {
        let overlong = "/" + String(repeating: "x", count: 103)
        #expect(overlong.utf8.count == 104)
        #expect(throws: SSHConfigError.self) {
            _ = try SSHCommandFactory(alias: "prod", controlPath: overlong)
        }
    }
}
