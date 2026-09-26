import { readVerifiedAttachmentBytes } from "@claudexor/core";
import type { HarnessRunSpec } from "@claudexor/schema";

/** Convert verified image resources to Codex's repeatable file-path arguments. */
export function codexImageArgs(attachments: HarnessRunSpec["attachments"] | undefined): string[] {
  return (attachments ?? []).flatMap((attachment) => {
    if (attachment.kind !== "image") return [];
    readVerifiedAttachmentBytes(attachment);
    return ["-i", attachment.path];
  });
}

/** Verified Codex app-server turn inputs; prompt bytes stay on the protocol channel. */
export function codexAppServerInput(
  spec: Pick<HarnessRunSpec, "prompt" | "attachments">,
): Array<Record<string, unknown>> {
  return [
    { type: "text", text: spec.prompt },
    ...(spec.attachments ?? []).flatMap((attachment) => {
      if (attachment.kind !== "image") return [];
      readVerifiedAttachmentBytes(attachment);
      return [{ type: "localImage", path: attachment.path }];
    }),
  ];
}
