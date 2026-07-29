import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import type { ResourceAttachmentRef } from "@claudexor/schema";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { openLocalAttachment, type LocalAttachment } from "./local-attachment.js";

async function controlJson(
  addr: ControlApiAddress,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await controlApiFetch(addr, path, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (response.ok) return body;
  const detail = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  throw new Error(String(detail["message"] ?? detail["error"] ?? `HTTP ${response.status}`));
}

export async function uploadLocalAttachment(
  addr: ControlApiAddress,
  attachment: LocalAttachment,
): Promise<ResourceAttachmentRef> {
  const created = (await controlJson(addr, "/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: attachment.kind,
      mime: attachment.mime,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
    }),
  })) as { uploadId: string };
  try {
    const source = createReadStream(attachment.path, {
      fd: openLocalAttachment(attachment),
      autoClose: true,
    });
    const hash = createHash("sha256");
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    source.pipe(hashingStream);
    const response = await controlApiFetch(
      addr,
      `/uploads/${encodeURIComponent(created.uploadId)}/bytes`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: Readable.toWeb(hashingStream) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(String(detail["message"] ?? detail["error"] ?? `HTTP ${response.status}`));
    }
    const expectedSha256 = `sha256:${hash.digest("hex")}`;
    const resource = (await controlJson(
      addr,
      `/uploads/${encodeURIComponent(created.uploadId)}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedSha256 }),
      },
    )) as { resourceId: string };
    return { resourceId: resource.resourceId };
  } catch (error) {
    await controlApiFetch(addr, `/uploads/${encodeURIComponent(created.uploadId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    throw error;
  }
}
