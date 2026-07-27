import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct SSHConfigTests {
    @Test func followsIncludesAndFiltersPatterns() throws {
        let files = [
            "/tmp/ssh/config": """
                Include conf.d/*.conf
                Host prod
                  HostName prod.internal
                Host *.example !blocked
                """,
            "/tmp/ssh/conf.d/one.conf": """
                Host jump "space alias"
                HostName jump.internal
                """,
        ]
        let scanner = SSHConfigScanner(
            readFile: { path in
                guard let value = files[path] else { throw SSHConfigError.unreadable(path) }
                return value
            },
            expandIncludes: { pattern, _ in
                pattern == "conf.d/*.conf" ? ["/tmp/ssh/conf.d/one.conf"] : []
            })
        let hosts = try scanner.scan(path: "/tmp/ssh/config")
        #expect(hosts.map(\.alias) == ["jump", "prod", "space alias"])
    }

    @Test func includeCyclesAreBounded() throws {
        let scanner = SSHConfigScanner(
            readFile: { _ in "Include config\nHost once" },
            expandIncludes: { _, _ in ["/tmp/config"] })
        #expect(try scanner.scan(path: "/tmp/config").map(\.alias) == ["once"])
    }

    @Test func resolvesThroughSSHToPreserveOpenSSHOwnership() throws {
        let resolver = OpenSSHResolver { executable, arguments in
            #expect(executable == "/usr/bin/ssh")
            #expect(arguments == ["-G", "prod"])
            return Data(
                """
                host prod
                user deploy
                hostname 10.0.0.4
                port 2202
                proxyjump bastion
                """.utf8)
        }
        let resolved = try resolver.resolve(alias: "prod")
        #expect(resolved.hostname == "10.0.0.4")
        #expect(resolved.user == "deploy")
        #expect(resolved.port == 2202)
        #expect(resolved.proxyJump == "bastion")
    }

    @Test func rejectsPatternOrOptionLikeAliases() {
        #expect(!SSHConfigScanner.isConcreteAlias("*"))
        #expect(!SSHConfigScanner.isConcreteAlias("prod?"))
        #expect(!SSHConfigScanner.isConcreteAlias("-oProxyCommand=bad"))
        #expect(SSHConfigScanner.isConcreteAlias("my-prod"))
    }
}
