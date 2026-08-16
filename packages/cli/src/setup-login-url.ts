import { C0_CONTROL_RE, TERM_ESCAPE_RE } from "./setup-login-io.js";

const OAUTH_URL_SIGNATURE_RE =
  /(oauth|authori[sz]e|login|sign[-_]?in|device|sso|verification|callback)/i;

/**
 * First sign-in-shaped URL in vendor CLI output, or null. Terminal escapes are
 * stripped first; trailing prose punctuation is trimmed; a docs link in a
 * banner never qualifies.
 */
const OAUTH_URL_SCAN_WINDOW = 8_192;

export function extractOAuthUrl(text: string): string | null {
  const plain = text.replace(TERM_ESCAPE_RE, "").replace(C0_CONTROL_RE, "");
  for (const match of plain.matchAll(/https:\/\/[^\s"'<>()[\]]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (OAUTH_URL_SIGNATURE_RE.test(url)) return url;
  }
  return null;
}

/**
 * Per-login detector. A match ending at the window's very end may be cut by a
 * chunk boundary (wave finding): it is published PROVISIONALLY, superseded by
 * a longer capture, and FINAL only once output continues past its end.
 */
export function createOAuthUrlDetector(): { push(chunk: Buffer): string | null } {
  let window = "";
  let published: string | null = null;
  let finalized = false;
  return {
    push(chunk) {
      if (finalized) return null;
      window = (window + chunk.toString("utf8")).slice(-OAUTH_URL_SCAN_WINDOW);
      const plain = window.replace(TERM_ESCAPE_RE, "").replace(C0_CONTROL_RE, "");
      const match = [...plain.matchAll(/https:\/\/[^\s"'<>()[\]]+/g)].find((m) =>
        OAUTH_URL_SIGNATURE_RE.test(m[0]),
      );
      if (!match) return null;
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if ((match.index ?? 0) + match[0].length < plain.length) {
        finalized = true;
        return url === published ? null : url;
      }
      if (published !== null && url.length <= published.length) return null;
      published = url;
      return url;
    },
  };
}
