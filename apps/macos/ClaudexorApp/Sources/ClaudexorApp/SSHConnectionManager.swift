import ClaudexorKit
import Darwin
import Foundation

struct SSHProcessOutput: Sendable {
    let stdout: Data
    let stderr: Data
    let status: Int32
    let stdinWriteError: String?
}

enum SSHConnectionError: Error, LocalizedError {
    case needsInteraction(String)
    case commandFailed(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case let .needsInteraction(detail):
            "SSH needs interactive authentication: \(detail)"
        case let .commandFailed(detail):
            "SSH command failed: \(detail)"
        case let .unavailable(detail):
            "SSH connection is unavailable: \(detail)"
        }
    }
}

struct SSHForward: Sendable, Hashable {
    let connectionID: UUID
    let localPort: Int
    let remotePort: Int
}

private final class SSHRunningProcess: @unchecked Sendable {
    private let lock = NSLock()
    private let process = Process()
    private let output = Pipe()
    private let errors = Pipe()
    private let input: Pipe?
    private let termination = DispatchSemaphore(value: 0)
    private var cancelled = false
    private let drainLock = NSLock()
    private var stdoutData = Data()
    private var stderrData = Data()
    private let inputWrites = DispatchGroup()
    private var stdinWriteError: String?

    init(invocation: SSHInvocation, hasInput: Bool) {
        input = hasInput ? Pipe() : nil
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        process.standardOutput = output
        process.standardError = errors
        if let input { process.standardInput = input }
    }

    func start(stdin: Data?) throws {
        lock.lock()
        if cancelled {
            lock.unlock()
            throw CancellationError()
        }
        if let input,
           fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == -1
        {
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            lock.unlock()
            throw error
        }
        do {
            let terminationSignal = termination
            process.terminationHandler = { _ in terminationSignal.signal() }
            try process.run()
        } catch {
            lock.unlock()
            throw error
        }
        // `Process` has duplicated this descriptor into the child now. Keeping
        // the parent's read end open would prevent an early child exit from
        // surfacing EPIPE and could leave a large archive upload blocked forever.
        try? input?.fileHandleForReading.close()
        lock.unlock()
        if let stdin, let input {
            // Write concurrently with stdout/stderr draining. SSH can emit
            // enough diagnostics while consuming stdin to fill both pipe
            // buffers; serially writing all input first deadlocks that case.
            inputWrites.enter()
            DispatchQueue.global(qos: .utility).async { [self] in
                defer {
                    try? input.fileHandleForWriting.close()
                    inputWrites.leave()
                }
                do {
                    try input.fileHandleForWriting.write(contentsOf: stdin)
                } catch {
                    lock.lock()
                    stdinWriteError = error.localizedDescription
                    if process.isRunning { process.terminate() }
                    lock.unlock()
                }
            }
        }
    }

    func waitForExit() -> SSHProcessOutput {
        // Drain both pipes before waiting: ssh -G, directory listings, and
        // command failures can exceed the kernel pipe buffer. Waiting first
        // would deadlock the child while it waits for us to read.
        let drains = DispatchGroup()
        drains.enter()
        DispatchQueue.global().async { [self] in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            drainLock.lock()
            stdoutData = data
            drainLock.unlock()
            drains.leave()
        }
        drains.enter()
        DispatchQueue.global().async { [self] in
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            drainLock.lock()
            stderrData = data
            drainLock.unlock()
            drains.leave()
        }
        // `Process.waitUntilExit()` can miss the termination notification for
        // a short-lived ssh child when called from a detached Swift task. The
        // handler is installed before `run()`, so this wait also covers a child
        // that exits before the drain workers start.
        termination.wait()
        inputWrites.wait()
        try? input?.fileHandleForWriting.close()
        drains.wait()
        drainLock.lock()
        let stdout = stdoutData
        let stderr = stderrData
        drainLock.unlock()
        lock.lock()
        let inputError = stdinWriteError
        lock.unlock()
        return SSHProcessOutput(
            stdout: stdout,
            stderr: stderr,
            status: process.terminationStatus,
            stdinWriteError: inputError)
    }

    func cancel() {
        lock.lock()
        cancelled = true
        try? input?.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        lock.unlock()
    }
}

actor SSHConnectionManager {
    private struct Master: Sendable {
        let connection: RemoteConnection
        let factory: SSHCommandFactory
    }

    private struct RunningProcess: Sendable {
        let connectionID: UUID?
        let process: SSHRunningProcess
    }

    private var masters: [UUID: Master] = [:]
    private var pendingMasters: [UUID: Master] = [:]
    private var forwards = Set<SSHForward>()
    private var runningProcesses: [UUID: RunningProcess] = [:]
    private var acceptsNewWork = true
    private let socketRoot: URL
    private let ownsSocketRoot: Bool
    private let socketRootError: String?

    init(socketRoot: URL? = nil) {
        let prepared = Self.prepareSocketRoot(socketRoot)
        self.socketRoot = prepared.url
        self.ownsSocketRoot = prepared.owned
        self.socketRootError = prepared.error
    }

    func factory(for connection: RemoteConnection) throws -> SSHCommandFactory {
        if let socketRootError {
            throw SSHConnectionError.unavailable(socketRootError)
        }
        guard acceptsNewWork else { throw CancellationError() }
        if let existing = masters[connection.id] { return existing.factory }
        return try SSHCommandFactory(
            alias: connection.sshAlias,
            controlPath: socketRoot
                .appendingPathComponent(String(connection.id.uuidString.prefix(16))).path)
    }

    func connectBatch(_ connection: RemoteConnection) async throws {
        try Task.checkCancellation()
        let command = try factory(for: connection)
        if await masterIsAlive(command, connectionID: connection.id) {
            masters[connection.id] = Master(connection: connection, factory: command)
            return
        }
        let pending = Master(connection: connection, factory: command)
        pendingMasters[connection.id] = pending
        defer { pendingMasters.removeValue(forKey: connection.id) }
        let result = try await run(
            command.startMaster(batchMode: true), connectionID: connection.id)
        guard result.status == 0,
              await masterIsAlive(command, connectionID: connection.id)
        else {
            let detail = boundedMessage(result.stderr)
            if sshBatchFailureNeedsInteraction(detail) {
                throw SSHConnectionError.needsInteraction(detail)
            }
            throw SSHConnectionError.commandFailed(
                detail.isEmpty
                    ? "ssh exited with status \(result.status) before its control master started"
                    : detail)
        }
        try Task.checkCancellation()
        guard acceptsNewWork else { throw CancellationError() }
        masters[connection.id] = pending
    }

    func interactiveMasterInvocation(for connection: RemoteConnection) throws -> SSHInvocation {
        try factory(for: connection).startMaster(batchMode: false)
    }

    func adoptInteractiveMaster(_ connection: RemoteConnection) async throws {
        let command = try factory(for: connection)
        guard acceptsNewWork,
              await masterIsAlive(command, connectionID: connection.id)
        else {
            throw SSHConnectionError.unavailable("the interactive SSH master did not start")
        }
        masters[connection.id] = Master(connection: connection, factory: command)
    }

    func execute(
        _ connection: RemoteConnection,
        remoteCommand: String,
        stdin: Data? = nil
    ) async throws -> SSHProcessOutput {
        guard let master = masters[connection.id] else {
            throw SSHConnectionError.unavailable("connect the host first")
        }
        let result = try await run(
            master.factory.remoteCommand(remoteCommand),
            stdin: stdin,
            connectionID: connection.id)
        guard result.status == 0 else {
            throw SSHConnectionError.commandFailed(boundedMessage(result.stderr))
        }
        return result
    }

    func terminalShellInvocation(
        _ connection: RemoteConnection,
        directory: String
    ) throws -> SSHInvocation {
        guard let master = masters[connection.id] else {
            throw SSHConnectionError.unavailable("connect the host first")
        }
        return master.factory.shell(in: directory)
    }

    func setupAttachInvocation(
        _ connection: RemoteConnection,
        jobID: String
    ) throws -> SSHInvocation {
        guard let master = masters[connection.id] else {
            throw SSHConnectionError.unavailable("connect the host first")
        }
        return try master.factory.setupAttach(jobID: jobID)
    }

    func openForward(
        _ connection: RemoteConnection,
        remotePort: Int
    ) async throws -> SSHForward {
        guard (1 ... 65_535).contains(remotePort),
              let master = masters[connection.id]
        else { throw SSHConnectionError.unavailable("invalid port or disconnected host") }
        let localPort = try allocateLoopbackPort()
        let result = try await run(
            master.factory.forward(localPort: localPort, remotePort: remotePort),
            connectionID: connection.id)
        guard result.status == 0 else {
            throw SSHConnectionError.commandFailed(boundedMessage(result.stderr))
        }
        let value = SSHForward(
            connectionID: connection.id, localPort: localPort, remotePort: remotePort)
        forwards.insert(value)
        return value
    }

    func closeForward(_ forward: SSHForward) async {
        guard forwards.remove(forward) != nil,
              let master = masters[forward.connectionID] else { return }
        _ = try? await run(
            master.factory.cancelForward(
                localPort: forward.localPort, remotePort: forward.remotePort),
            connectionID: forward.connectionID)
    }

    func disconnect(_ connectionID: UUID) async {
        cancelInFlight(for: connectionID)
        forwards = Set(forwards.filter { $0.connectionID != connectionID })
        let master = masters.removeValue(forKey: connectionID)
            ?? pendingMasters.removeValue(forKey: connectionID)
        guard let master else { return }
        _ = try? await run(
            master.factory.stopMaster(),
            connectionID: connectionID,
            allowDuringShutdown: true)
    }

    func cancelInFlight(for connectionID: UUID) {
        for value in runningProcesses.values where value.connectionID == connectionID {
            value.process.cancel()
        }
    }

    func cancelAllInFlight() {
        for value in runningProcesses.values { value.process.cancel() }
    }

    #if DEBUG
    func runForTesting(
        _ invocation: SSHInvocation,
        stdin: Data? = nil
    ) async throws -> SSHProcessOutput {
        try await run(invocation, stdin: stdin)
    }
    #endif

    func shutdown() async {
        acceptsNewWork = false
        cancelAllInFlight()
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !runningProcesses.isEmpty, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        let connections = Set(masters.keys).union(pendingMasters.keys)
        for connectionID in connections { await disconnect(connectionID) }
        forwards.removeAll()
        pendingMasters.removeAll()
        if ownsSocketRoot {
            try? FileManager.default.removeItem(at: socketRoot)
        }
    }

    private static func prepareSocketRoot(
        _ requested: URL?
    ) -> (url: URL, owned: Bool, error: String?) {
        let fileManager = FileManager.default
        let owned = requested == nil
        let root: URL
        if let requested {
            root = requested
        } else {
            // macOS's per-user TMPDIR path is already long enough that adding a
            // UUID directory and socket name can exceed sockaddr_un.sun_path.
            // A random, private directory directly under /tmp keeps the literal
            // ControlPath short; the final directory is still lstat/chmod
            // validated below and removed during shutdown.
            let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)
            root = URL(fileURLWithPath: "/tmp", isDirectory: true)
                .appendingPathComponent("cx-\(getuid())-\(nonce)", isDirectory: true)
        }
        do {
            try fileManager.createDirectory(
                at: root,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
        } catch let error as CocoaError where error.code == .fileWriteFileExists {
            // An injected root may intentionally pre-exist; it is accepted only
            // after the no-symlink, same-user ownership checks below.
            if owned {
                return (
                    root, owned,
                    "could not create a unique private SSH control directory")
            }
        } catch {
            return (
                root, owned,
                "could not create the private SSH control directory: \(error.localizedDescription)")
        }
        var info = stat()
        guard lstat(root.path, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == getuid()
        else {
            return (
                root, owned,
                "the SSH control directory is not a private app-owned directory")
        }
        guard chmod(root.path, S_IRWXU) == 0 else {
            return (root, owned, "could not secure the SSH control directory")
        }
        return (root, owned, nil)
    }

    private func masterIsAlive(
        _ factory: SSHCommandFactory,
        connectionID: UUID
    ) async -> Bool {
        guard
            let result = try? await run(
                factory.checkMaster(), connectionID: connectionID)
        else { return false }
        return result.status == 0
    }

    private func run(
        _ invocation: SSHInvocation,
        stdin: Data? = nil,
        connectionID: UUID? = nil,
        allowDuringShutdown: Bool = false
    ) async throws -> SSHProcessOutput {
        guard acceptsNewWork || allowDuringShutdown else { throw CancellationError() }
        try Task.checkCancellation()
        let id = UUID()
        let process = SSHRunningProcess(invocation: invocation, hasInput: stdin != nil)
        runningProcesses[id] = RunningProcess(connectionID: connectionID, process: process)
        defer { runningProcesses.removeValue(forKey: id) }
        return try await withTaskCancellationHandler {
            do {
                try process.start(stdin: stdin)
            } catch {
                try Task.checkCancellation()
                throw error
            }
            let result = await Task.detached {
                process.waitForExit()
            }.value
            try Task.checkCancellation()
            if result.status == 0, let detail = result.stdinWriteError {
                throw SSHConnectionError.unavailable(
                    "could not finish sending command input: \(detail)")
            }
            return result
        } onCancel: {
            process.cancel()
        }
    }
}

/// BatchMode suppresses prompts, so only authentication/first-seen-host
/// failures should be retried in the embedded PTY. Operational and security
/// failures must remain ordinary errors: a terminal cannot repair DNS,
/// connectivity, socket-path, config-permission, or changed/revoked-host-key
/// failures and presenting one implies that user input is expected.
///
/// Trust boundary: LogLevel=ERROR on the batch master
/// (SSHCommandFactory.startMaster) suppresses the INFO-level display of the
/// server's pre-auth banner, but it does NOT keep server-controlled bytes out
/// of stderr: OpenSSH logs the SSH_MSG_DISCONNECT text at ERROR level
/// ("Received disconnect from <host> port N:2: <up to ~400 server bytes>"),
/// echoes a hostile identification string in "Bad remote protocol version
/// identification: '<server bytes>'", and reports banner-exchange failures.
/// Those server-echo line families are dropped below BEFORE any substring
/// matching, so a hostile server cannot plant "password:"/"the authenticity
/// of host" text and provoke a false interactive trust prompt. The
/// changed/revoked-host-key guard is evaluated first on purpose: when both
/// marker families appear, the hard refusal wins.
private let sshServerEchoLinePrefixes = [
    "received disconnect from ",
    "bad remote protocol version identification",
    "banner exchange",
]

func sshBatchFailureNeedsInteraction(_ detail: String) -> Bool {
    let message = detail
        .lowercased()
        .split(separator: "\n", omittingEmptySubsequences: true)
        .filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return !sshServerEchoLinePrefixes.contains { trimmed.hasPrefix($0) }
        }
        .joined(separator: "\n")
    guard !message.isEmpty else { return false }

    let changedOrRevokedHostKey =
        message.contains("remote host identification has changed")
        || message.contains("revoked host key")
        || message.contains("has changed and you have requested strict checking")
        || (message.contains("host key for") && message.contains("has changed"))
    if changedOrRevokedHostKey {
        return false
    }

    let interactiveFailures = [
        "permission denied (",
        "permission denied, please try again",
        "host key verification failed",
        "the authenticity of host",
        "are you sure you want to continue connecting",
        "password:",
        "enter passphrase",
        "verification code",
        "keyboard-interactive",
        "keyboard interactive",
        "enter pin for",
    ]
    return interactiveFailures.contains(where: message.contains)
}

private func boundedMessage(_ data: Data) -> String {
    String(decoding: data.suffix(8_192), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func allocateLoopbackPort() throws -> Int {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw SSHConnectionError.unavailable("could not allocate port") }
    defer { close(descriptor) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { throw SSHConnectionError.unavailable("could not bind local port") }
    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let read = withUnsafeMutablePointer(to: &actual) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(descriptor, $0, &length)
        }
    }
    guard read == 0 else { throw SSHConnectionError.unavailable("could not inspect local port") }
    return Int(UInt16(bigEndian: actual.sin_port))
}
