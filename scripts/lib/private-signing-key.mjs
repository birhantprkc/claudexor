import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** Read an offline signing key from the already-validated descriptor.
 * Symlinks, non-regular files, foreign ownership, and permissions other than
 * 0600 fail closed before any key bytes are returned. */
export function readPrivateSigningKey(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("private signing key must not be a symlink", { cause: error });
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("private signing key must be a regular file");
    if (typeof process.getuid !== "function") {
      throw new Error("private signing key ownership cannot be verified on this platform");
    }
    if (stat.uid !== process.getuid()) {
      throw new Error("private signing key must be owned by the current user");
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("private signing key permissions must be exactly 0600");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
