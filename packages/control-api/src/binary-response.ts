import type { ServerResponse } from "node:http";

/** RFC 6266/RFC 5987 filename projection with an ASCII compatibility fallback. */
export function inlineContentDisposition(fileName: string): string {
  const validUtf8 = Buffer.from(fileName, "utf8")
    .toString("utf8")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "_");
  const bounded = [...validUtf8].slice(0, 180).join("") || "remote-file";
  const fallback =
    [...bounded]
      .map((character) => (/^[A-Za-z0-9._ -]$/.test(character) ? character : "_"))
      .join("")
      .slice(0, 180) || "remote-file";
  const encoded = encodeURIComponent(bounded).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function writeBinaryResponse(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  fileName: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    "content-disposition": inlineContentDisposition(fileName),
    "cache-control": "private, no-store",
  });
  response.end(body);
}
