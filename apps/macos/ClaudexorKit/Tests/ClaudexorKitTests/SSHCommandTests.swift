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
            "-S", "/tmp/cx/master", "-o", "ControlMaster=no", "prod", "true",
        ])
        #expect(factory.forward(localPort: 4400, remotePort: 3000).arguments.contains(
            "127.0.0.1:4400:127.0.0.1:3000"))
    }

    @Test func remoteDirectoryIsQuotedWithoutLocalShellInterpolation() throws {
        let factory = try SSHCommandFactory(alias: "prod", controlPath: "/tmp/cx/master")
        let command = try #require(factory.shell(in: "/srv/it's app").arguments.last)
        #expect(command == "cd -- '/srv/it'\"'\"'s app' && exec \"${SHELL:-/bin/sh}\" -l")
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
