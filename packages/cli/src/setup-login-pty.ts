import { existsSync } from "node:fs";

/** Refusal when this host has no way to give a login a terminal. */
export const PTY_UNAVAILABLE =
  "this sign-in needs a terminal on stdin and no terminal helper (expect, script) is available here; run the CLI login instead";

/**
 * Wrap a login command that needs a real terminal on stdin.
 *
 * Proven by experiment on this platform pair (2026-08-16): BSD `script(1)`
 * calls `tcgetattr` on its OWN stdin and dies with "Operation not supported"
 * the moment that stdin is a pipe, which is exactly how a daemon-hosted runner
 * spawns it — so macOS cannot use it. `expect(1)`, which ships with macOS,
 * allocates the pty itself and relays plain pipes, and util-linux `script`
 * accepts non-tty stdio where `expect` is usually not installed. Probing for
 * the tool rather than branching on the platform therefore lands on the one
 * that works on both, with a typed refusal when neither exists.
 *
 * The command is passed to Tcl brace-quoted; a word containing a brace or a
 * backslash is REFUSED rather than escaped, because a mis-escaped word would
 * become a different command than the manifest digest sealed.
 */
export function ptyWrappedCommand(
  binary: string,
  args: string[],
  exists: (path: string) => boolean = existsSync,
): { binary: string; args: string[] } | null {
  const words = [binary, ...args];
  const EXPECT = "/usr/bin/expect";
  const SCRIPT = "/usr/bin/script";
  if (exists(EXPECT)) {
    if (words.some((word) => /[{}\\\n]/.test(word))) return null;
    const spawnCommand = words.map((word) => `{${word}}`).join(" ");
    return {
      binary: EXPECT,
      // `interact` relays our pipes both ways for the whole login; the vendor
      // sees a terminal, we see its URL and can write the pasted code.
      args: ["-c", `set timeout -1; spawn -noecho ${spawnCommand}; interact`],
    };
  }
  if (exists(SCRIPT) && process.platform !== "darwin") {
    const quoted = words.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
    return { binary: SCRIPT, args: ["-q", "-c", quoted, "/dev/null"] };
  }
  return null;
}
