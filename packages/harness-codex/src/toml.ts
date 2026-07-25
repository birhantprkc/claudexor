/**
 * A TOML basic-string literal for a `-c key=value` override. `developer_instructions`
 * is a documented additive Codex config key (layered as a developer block BEFORE
 * AGENTS.md, not a replacement); passing per-invocation `-c` keeps it isolated
 * to this run (never a shared-config mutation). Instructions may contain quotes
 * and newlines, so they are TOML-escaped.
 */
export function tomlBasicString(value: string): string {
  // TOML basic-string escapes, built by code point so the SOURCE carries no
  // literal control characters: a backslash and quote are escaped, a literal
  // newline/tab/CR become their escapes (a raw newline is invalid in a basic
  // string), other control chars become \uXXXX, and everything else is literal.
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code === 9) out += "\\t";
    else if (code < 32 || code === 127) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}
