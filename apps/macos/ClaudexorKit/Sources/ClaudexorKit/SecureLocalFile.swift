import Darwin
import Foundation

enum SecureLocalFileError: Error, LocalizedError, Equatable {
    case insecureDirectory(String)
    case insecureFile(String)

    var errorDescription: String? {
        switch self {
        case let .insecureDirectory(path):
            "Refusing to read private metadata outside an owner-only directory: \(path)"
        case let .insecureFile(path):
            "Refusing to read metadata that is not an owner-only regular file: \(path)"
        }
    }
}

/// Reads one app/daemon-owned 0600 metadata file through the descriptor for its
/// proven 0700 parent. The path is used only to open the parent; the leaf open,
/// validation, and read all share one no-follow descriptor chain.
enum SecureLocalFile {
    static func readPrivateData(
        at url: URL,
        expectedOwner: uid_t = geteuid()
    ) throws -> Data? {
        let directory = url.deletingLastPathComponent()
        let directoryFD = open(
            directory.path,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if directoryFD < 0 {
            if errno == ENOENT { return nil }
            throw SecureLocalFileError.insecureDirectory(directory.path)
        }
        defer { close(directoryFD) }

        var directoryStatus = stat()
        guard fstat(directoryFD, &directoryStatus) == 0,
              fileType(directoryStatus) == mode_t(S_IFDIR),
              directoryStatus.st_uid == expectedOwner,
              permissionBits(directoryStatus) == 0o700
        else {
            throw SecureLocalFileError.insecureDirectory(directory.path)
        }

        let leaf = url.lastPathComponent
        guard !leaf.isEmpty, leaf != ".", leaf != "..", !leaf.contains("/") else {
            throw SecureLocalFileError.insecureFile(url.path)
        }
        let fileFD = leaf.withCString {
            openat(directoryFD, $0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        if fileFD < 0 {
            if errno == ENOENT { return nil }
            throw SecureLocalFileError.insecureFile(url.path)
        }
        defer { close(fileFD) }

        var fileStatus = stat()
        guard fstat(fileFD, &fileStatus) == 0,
              fileType(fileStatus) == mode_t(S_IFREG),
              fileStatus.st_uid == expectedOwner,
              permissionBits(fileStatus) == 0o600
        else {
            throw SecureLocalFileError.insecureFile(url.path)
        }
        return try FileHandle(
            fileDescriptor: fileFD,
            closeOnDealloc: false
        ).readToEnd() ?? Data()
    }

    private static func fileType(_ status: stat) -> mode_t {
        status.st_mode & mode_t(S_IFMT)
    }

    private static func permissionBits(_ status: stat) -> mode_t {
        status.st_mode & 0o777
    }
}
