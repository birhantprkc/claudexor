import { existsSync } from "node:fs";

/** Refusal when this host has no way to give a login a terminal. */
export const PTY_UNAVAILABLE =
  "this sign-in needs a terminal on stdin and no terminal helper (expect, script) is available here; run the CLI login instead";

/** Refusal when the sealed command cannot be carried to the helper verbatim. */
export const PTY_UNQUOTABLE =
  "this sign-in command contains characters the terminal helper cannot carry unchanged; run the CLI login instead";

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
): { binary: string; args: string[] } | { refusal: string } {
  const words = [binary, ...args];
  const EXPECT = "/usr/bin/expect";
  const SCRIPT = "/usr/bin/script";
  if (exists(EXPECT)) {
    if (words.some((word) => /[{}\\\n]/.test(word))) return { refusal: PTY_UNQUOTABLE };
    const spawnCommand = words.map((word) => `{${word}}`).join(" ");
    return {
      binary: EXPECT,
      // `interact` relays our pipes both ways for the whole login; the vendor
      // sees a terminal, we see its URL and can write the pasted code.
      //
      // Everything after it exists because `interact` returns expect's OWN
      // status, not the vendor's: without this an authentication that the
      // vendor REJECTED would be recorded as a successful login, and its
      // diagnostic tail would be dropped. `wait` yields the child's exit code,
      // a signal death is reported as one, and a spawn that never started is
      // 127 — the same shape a shell would give.
      args: [
        "-c",
        `set timeout -1; if {[catch {spawn -noecho ${spawnCommand}}]} { exit 127 }; ` +
          "set pid [exp_pid]; interact; catch {wait} r; " +
          "if {[lsearch -exact $r CHILDKILLED] >= 0} { exit 129 }; " +
          "catch {exec kill -TERM $pid}; exit [lindex $r 3]",
      ],
    };
  }
  if (exists(SCRIPT) && process.platform !== "darwin") {
    const quoted = words.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
    // `-e` for the same reason: without it script reports its own status and
    // a rejected login reads as a successful one.
    return { binary: SCRIPT, args: ["-e", "-q", "-c", quoted, "/dev/null"] };
  }
  return { refusal: PTY_UNAVAILABLE };
}
