const BEARER_SCHEME = "bearer";

/** Parse the HTTP Bearer credential without overlapping regular-expression quantifiers. */
export function bearerCredential(header: string | undefined): string | undefined {
  if (!header || header.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) {
    return undefined;
  }
  let cursor = BEARER_SCHEME.length;
  if (header[cursor] !== " " && header[cursor] !== "\t") return undefined;
  while (header[cursor] === " " || header[cursor] === "\t") cursor += 1;
  const credential = header.slice(cursor).trim();
  return credential || undefined;
}
