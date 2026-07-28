#!/usr/bin/env bash
set -euo pipefail

# Name each stage: this smoke only ever runs inside the release workflow,
# so a bare non-zero exit costs a whole candidate build to diagnose.
step() { printf "== %s\n" "$1"; }

archive=${1:?usage: smoke-darwin-remote-runtime.sh ARCHIVE}
test -f "$archive"
case "$(basename "$archive")" in
  *-darwin-x64.tar.gz|*-darwin-arm64.tar.gz) ;;
  *) echo "Darwin smoke requires a Darwin runtime archive" >&2; exit 64 ;;
esac

# The smoke HOME must be canonical AND short, and the default mktemp root is
# neither. On macOS `mktemp -d` hands back /var/folders/<long>/T/..., and /var
# is a symlink to /private/var: the runtime refuses a non-canonical owned
# directory parent (a symlink-swap fence), so bootstrap fails for a reason no
# real user hits. Canonicalizing that path then ADDS eight characters and the
# daemon socket beneath it blows past the 104-byte sun_path cap, so the daemon
# silently never comes up. Rooting at /tmp keeps the canonical form short
# (/private/tmp/...), which satisfies both.
work=$(cd "$(mktemp -d /tmp/claudexor-darwin-smoke.XXXXXX)" && pwd -P)
runtime="$work/runtime"
smoke_home="$work/home"
cleanup() {
  HOME="$smoke_home" "$runtime/bin/claudexor" daemon stop --json >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$runtime" "$smoke_home"
tar -xzf "$archive" -C "$runtime"

step "probe"
probe=$(HOME="$smoke_home" "$runtime/bin/claudexor" remote probe --json)
node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || !value.target.startsWith("darwin-") || value.protocolMajor !== 3) process.exit(1);
' "$probe"

# `/usr/bin/script` supplies a real PTY, exercising the runtime command through
# the same terminal primitive SwiftTerm ultimately fronts.
step "probe through a PTY"
pty_output=$(HOME="$smoke_home" /usr/bin/script -q /dev/null \
  "$runtime/bin/claudexor" remote probe --json)
# Parse the payload instead of matching its bytes: `--json` prints INDENTED
# JSON, and a PTY additionally rewrites line endings, so a literal
# `"protocolMajor":3` substring never appears. Strip the carriage returns the
# PTY adds, take the JSON object, and assert the value.
printf '%s' "$pty_output" | tr -d '\r' | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      console.error("darwin PTY smoke: no JSON object in the probe output");
      process.exit(1);
    }
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!value.ok || value.protocolMajor !== 3 || !String(value.target).startsWith("darwin-")) {
      console.error("darwin PTY smoke: unexpected probe payload " + JSON.stringify(value));
      process.exit(1);
    }
  });
'

step "bootstrap"
bootstrap=$(HOME="$smoke_home" "$runtime/bin/claudexor" remote bootstrap --json)
port=$(node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || value.endpoint?.host !== "127.0.0.1") process.exit(1);
  process.stdout.write(String(value.endpoint.port));
' "$bootstrap")
token=$(node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.endpoint?.token) process.exit(1);
  process.stdout.write(value.endpoint.token);
' "$bootstrap")
step "handshake"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $token" \
  -H 'X-Claudexor-Protocol-Major: 3' \
  -H 'Content-Type: application/json' \
  -d '{"protocolMajor":3,"client":"release-darwin-pty-smoke"}' \
  "http://127.0.0.1:${port}/v2/handshake" >/dev/null

echo "Darwin remote runtime + PTY smoke passed"
