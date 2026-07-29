import { z } from "zod/v3";

export const SetupLoginJobId = z.string().regex(/^setup-[A-Za-z0-9-]+$/);
export const SetupLoginExecutionId = z.string().regex(/^[A-Za-z0-9-]+$/);
export const SetupLoginAbsolutePath = z.string().startsWith("/");

export const SetupClientPtyPermitWaitMs = z
  .number()
  .int()
  .positive()
  .safe()
  .optional()
  .describe(
    "Sealed runner-to-daemon permit window measured from a deferred client-PTY runner's actual start; absent preserves the legacy absolute-deadline protocol.",
  );
