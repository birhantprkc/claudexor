#!/usr/bin/env bash
set -euo pipefail

archive=${1:?usage: smoke-darwin-remote-runtime.sh ARCHIVE}
test -f "$archive"
case "$(basename "$archive")" in
  *-darwin-x64.tar.gz|*-darwin-arm64.tar.gz) ;;
  *) echo "Darwin smoke requires a Darwin runtime archive" >&2; exit 64 ;;
esac

work=$(mktemp -d)
runtime="$work/runtime"
smoke_home="$work/home"
cleanup() {
  HOME="$smoke_home" "$runtime/bin/claudexor" daemon stop --json >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$runtime" "$smoke_home"
tar -xzf "$archive" -C "$runtime"

probe=$(HOME="$smoke_home" "$runtime/bin/claudexor" remote probe --json)
node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || !value.target.startsWith("darwin-") || value.protocolMajor !== 3) process.exit(1);
' "$probe"

# `/usr/bin/script` supplies a real PTY, exercising the runtime command through
# the same terminal primitive SwiftTerm ultimately fronts.
pty_output=$(HOME="$smoke_home" /usr/bin/script -q /dev/null \
  "$runtime/bin/claudexor" remote probe --json)
printf '%s' "$pty_output" | grep -q '"protocolMajor":3'

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
curl --fail --silent --show-error \
  -H "Authorization: Bearer $token" \
  -H 'X-Claudexor-Protocol-Major: 3' \
  -H 'Content-Type: application/json' \
  -d '{"protocolMajor":3,"client":"release-darwin-pty-smoke"}' \
  "http://127.0.0.1:${port}/v2/handshake" >/dev/null

echo "Darwin remote runtime + PTY smoke passed"
