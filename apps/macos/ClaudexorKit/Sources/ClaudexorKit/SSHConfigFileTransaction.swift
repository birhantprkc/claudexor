import Darwin
import Foundation

/// One descriptor-pinned scan/backup/append transaction for the user's SSH
/// config. A live final symlink is supported by pinning and revalidating its
/// resolved inode; a dangling or swapped link is refused.
enum SSHConfigFileTransaction {
    struct Result {
        let backupPath: String?
        let createdConfig: Bool
    }

    static func append(
        _ bytes: Data,
        to configPath: String,
        backupDate: Date,
        validateExisting: (String) throws -> Void
    ) throws -> Result {
        let directoryPath = (configPath as NSString).deletingLastPathComponent
        if !FileManager.default.fileExists(atPath: directoryPath) {
            try FileManager.default.createDirectory(
                atPath: directoryPath,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        }

        let directoryFD = open(directoryPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryFD >= 0 else { throw failure("could not open \(directoryPath)") }
        defer { close(directoryFD) }
        let directoryIdentity = try identity(of: directoryFD, requiring: mode_t(S_IFDIR))

        let leaf = (configPath as NSString).lastPathComponent
        guard !leaf.isEmpty, leaf != ".", leaf != "..", !leaf.contains("/") else {
            throw failure("invalid config path \(configPath)")
        }
        let opened = try openConfig(directoryFD: directoryFD, leaf: leaf, path: configPath)
        defer { close(opened.fd) }
        guard flock(opened.fd, LOCK_EX) == 0 else {
            throw failure("could not lock \(configPath)")
        }
        defer { flock(opened.fd, LOCK_UN) }

        let fileIdentity = try identity(of: opened.fd, requiring: mode_t(S_IFREG))
        guard fileIdentity.owner == geteuid() else {
            throw failure("\(configPath) is not owned by the current user")
        }
        let existingData = try readAll(from: opened.fd)
        guard let existing = String(data: existingData, encoding: .utf8) else {
            throw failure("\(configPath) is not valid UTF-8")
        }
        if !opened.created { try validateExisting(existing) }
        try requireCurrentSnapshot(
            directoryPath: directoryPath,
            directoryIdentity: directoryIdentity,
            directoryFD: directoryFD,
            leaf: leaf,
            fileIdentity: fileIdentity,
            fileFD: opened.fd,
            expectedData: existingData,
            configPath: configPath)

        let backupPath = opened.created ? nil : try backUp(
            existingData,
            mode: fileIdentity.permissions,
            configPath: configPath,
            directoryFD: directoryFD,
            leaf: leaf,
            date: backupDate)
        try requireCurrentSnapshot(
            directoryPath: directoryPath,
            directoryIdentity: directoryIdentity,
            directoryFD: directoryFD,
            leaf: leaf,
            fileIdentity: fileIdentity,
            fileFD: opened.fd,
            expectedData: existingData,
            configPath: configPath)

        guard lseek(opened.fd, 0, SEEK_END) >= 0 else {
            throw failure("could not seek to the end of \(configPath)")
        }
        let separator = existing.isEmpty ? "" : (existing.hasSuffix("\n") ? "\n" : "\n\n")
        var appended = Data(separator.utf8)
        appended.append(bytes)
        try writeAll(appended, to: opened.fd)
        return Result(backupPath: backupPath, createdConfig: opened.created)
    }

    private struct Identity: Equatable {
        let device: dev_t
        let inode: ino_t
        let owner: uid_t
        let permissions: mode_t
    }

    private static func openConfig(
        directoryFD: Int32,
        leaf: String,
        path: String
    ) throws -> (fd: Int32, created: Bool) {
        let existingFD = leaf.withCString {
            openat(directoryFD, $0, O_RDWR | O_APPEND | O_NONBLOCK | O_CLOEXEC)
        }
        if existingFD >= 0 { return (existingFD, false) }
        guard errno == ENOENT else { throw failure("could not open \(path)") }

        let createdFD = leaf.withCString {
            openat(
                directoryFD,
                $0,
                O_RDWR | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                0o600)
        }
        guard createdFD >= 0 else {
            throw failure("could not create \(path) without following a link")
        }
        guard fchmod(createdFD, 0o600) == 0 else {
            close(createdFD)
            leaf.withCString { _ = unlinkat(directoryFD, $0, 0) }
            throw failure("could not set private permissions on \(path)")
        }
        return (createdFD, true)
    }

    private static func identity(of fd: Int32, requiring expectedType: mode_t) throws -> Identity {
        var status = stat()
        guard fstat(fd, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == expectedType
        else {
            throw failure("opened path is not the expected file type")
        }
        return Identity(
            device: status.st_dev,
            inode: status.st_ino,
            owner: status.st_uid,
            permissions: status.st_mode & 0o777)
    }

    private static func requireCurrentSnapshot(
        directoryPath: String,
        directoryIdentity: Identity,
        directoryFD: Int32,
        leaf: String,
        fileIdentity: Identity,
        fileFD: Int32,
        expectedData: Data,
        configPath: String
    ) throws {
        let currentDirectoryFD = open(directoryPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard currentDirectoryFD >= 0 else {
            throw failure("config directory changed during write")
        }
        defer { close(currentDirectoryFD) }
        guard try identity(
            of: currentDirectoryFD,
            requiring: mode_t(S_IFDIR)) == directoryIdentity
        else {
            throw failure("config directory changed during write")
        }

        let currentFD = leaf.withCString {
            openat(directoryFD, $0, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        }
        guard currentFD >= 0 else { throw failure("\(configPath) changed during write") }
        defer { close(currentFD) }
        guard try identity(of: currentFD, requiring: mode_t(S_IFREG)) == fileIdentity else {
            throw failure("\(configPath) changed during write")
        }
        guard try readAll(from: fileFD) == expectedData else {
            throw failure("\(configPath) contents changed during write")
        }
    }

    private static func readAll(from fd: Int32) throws -> Data {
        guard lseek(fd, 0, SEEK_SET) >= 0 else { throw failure("could not read SSH config") }
        return try FileHandle(
            fileDescriptor: fd,
            closeOnDealloc: false
        ).readToEnd() ?? Data()
    }

    private static func backUp(
        _ data: Data,
        mode: mode_t,
        configPath: String,
        directoryFD: Int32,
        leaf: String,
        date: Date
    ) throws -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let base = "\(leaf).claudexor-backup-\(formatter.string(from: date))"
        var counter = 1
        while true {
            let name = counter == 1 ? base : "\(base)-\(counter)"
            let backupFD = name.withCString {
                openat(
                    directoryFD,
                    $0,
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    mode)
            }
            if backupFD < 0 {
                if errno == EEXIST {
                    counter += 1
                    continue
                }
                throw failure("could not create a backup for \(configPath)")
            }
            do {
                defer { close(backupFD) }
                guard fchmod(backupFD, mode) == 0 else {
                    throw failure("could not preserve SSH config backup permissions")
                }
                try writeAll(data, to: backupFD)
                guard fsync(backupFD) == 0 else {
                    throw failure("could not flush the SSH config backup")
                }
            } catch {
                name.withCString { _ = unlinkat(directoryFD, $0, 0) }
                throw error
            }
            return URL(fileURLWithPath: configPath)
                .deletingLastPathComponent()
                .appendingPathComponent(name).path
        }
    }

    private static func writeAll(_ data: Data, to fd: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var offset = 0
            while offset < rawBuffer.count {
                let written = Darwin.write(
                    fd,
                    base.advanced(by: offset),
                    rawBuffer.count - offset)
                guard written > 0 else { throw failure("could not write SSH config bytes") }
                offset += written
            }
        }
    }

    private static func failure(_ detail: String) -> SSHConfigWriteError {
        .writeFailed(detail)
    }
}
