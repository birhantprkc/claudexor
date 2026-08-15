import { isAbsolute as isPosixAbsolute } from "node:path/posix";
import { isAbsolute as isWin32Absolute } from "node:path/win32";
import { z } from "zod/v3";

export function isCrossPlatformAbsolutePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return false;
  }
  return isPosixAbsolute(value) || isWin32Absolute(value);
}

export const SetupLoginJobId = z.string().regex(/^setup-[A-Za-z0-9-]+$/);
export const SetupLoginExecutionId = z.string().regex(/^[A-Za-z0-9-]+$/);
export const SetupLoginAbsolutePath = z
  .string()
  .min(1)
  .refine(isCrossPlatformAbsolutePath, {
    message: 'must be an absolute path (POSIX or Windows)',
  });

export const SetupClientPtyPermitWaitMs = z
  .number()
  .int()
  .positive()
  .safe()
  .optional()
  .describe(
    "Sealed runner-to-daemon permit window measured from a deferred client-PTY runner's actual start; absent preserves the legacy absolute-deadline protocol.",
  );
