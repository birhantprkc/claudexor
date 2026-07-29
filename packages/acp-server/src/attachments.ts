import type * as acp from "@agentclientprotocol/sdk";

/** Translate ACP-native content blocks into the daemon attachment input shape. */
export function attachmentInputs(prompt: acp.ContentBlock[]): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  for (const [index, block] of prompt.entries()) {
    if (block.type === "image") {
      attachments.push({
        kind: "image",
        mime: block.mimeType,
        name: `acp-image-${index + 1}`,
        data: block.data,
      });
    } else if (block.type === "resource" && "blob" in block.resource) {
      attachments.push({
        kind: "file",
        mime: block.resource.mimeType ?? "application/octet-stream",
        name: `acp-resource-${index + 1}`,
        data: block.resource.blob,
      });
    } else if (block.type === "resource" && "text" in block.resource) {
      attachments.push({
        kind: "file",
        mime: block.resource.mimeType ?? "text/plain",
        name: `acp-resource-${index + 1}`,
        data: Buffer.from(block.resource.text, "utf8").toString("base64"),
      });
    }
  }
  return attachments;
}
