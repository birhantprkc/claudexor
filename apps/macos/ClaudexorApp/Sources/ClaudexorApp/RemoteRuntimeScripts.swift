// Audited POSIX scripts used by RemoteRuntimeInstaller. Keeping the remote
// transaction text beside, rather than inside, the actor makes both owners
// readable without changing the single call path or interpolation boundary.
extension RemoteRuntimeInstaller {
    static let installScript = """
        set -eu
        version=$1
        expected=$2
        expected_current=$3
        previous_version=$4
        previous_sha=$5
        case "$version" in *[!0-9.]*|'') exit 64;; esac
        case "$expected" in *[!0-9a-f]*|'') exit 64;; esac
        test "${#expected}" -eq 64
        case "$expected_current" in
          -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
          versions/*)
            case "$expected_current" in */*/*|*..*) exit 64;; esac
            case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
            case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
            test "${#previous_sha}" -eq 40;;
          *) exit 64;;
        esac
        root="$HOME/.claudexor/remote"
        archive="$root/incoming/$expected.tar.gz"
        staging="$root/.staging/$version-$$"
        candidate="versions/$version-$expected"
        destination="$root/$candidate"
        lock="$root/.install-lock"
        umask 077
        mkdir -p "$root/incoming" "$root/.staging" "$root/versions"
        if ! mkdir "$lock" 2>/dev/null; then
          echo "another install holds the lock $lock (remove it if no install is running)" >&2
          exit 75
        fi
        cleanup() {
          rm -rf "$staging"
          rmdir "$lock" 2>/dev/null || true
        }
        trap cleanup EXIT HUP INT TERM
        actual_current=-
        if test -L "$root/current"; then
          actual_current=$(readlink "$root/current")
        elif test -e "$root/current"; then
          exit 73
        fi
        test "$actual_current" = "$expected_current" || exit 75
        if command -v shasum >/dev/null 2>&1; then
          actual=$(shasum -a 256 "$archive" | awk '{print $1}')
        elif command -v sha256sum >/dev/null 2>&1; then
          actual=$(sha256sum "$archive" | awk '{print $1}')
        else
          exit 69
        fi
        test "$actual" = "$expected"
        # Capture both listings through plain assignments: `set -e` propagates
        # a tar failure out of `x=$(...)`, while a substitution inline in the
        # heredoc body would silently truncate the listing on a corrupt
        # archive. Heredoc expansion never field-splits or globs, and the
        # anchored patterns are closed under raw-newline entry names: any
        # `..` path component leaves `..`, `../*`, `*/../*` or `*/..` on at
        # least one physical line no matter where the name is split.
        listing=$(tar -tzf "$archive")
        while IFS= read -r entry; do
          case "$entry" in /*|..|../*|*/../*|*/..) exit 65;; esac
        done <<EOF
        $listing
        EOF
        verbose=$(tar -tvzf "$archive")
        while IFS= read -r detail; do
          case "$detail" in
            -*) ;;
            d*) ;;
            *) exit 65;;
          esac
        done <<EOF
        $verbose
        EOF
        mkdir "$staging"
        tar -xzf "$archive" -C "$staging" --no-same-owner
        test -x "$staging/bin/claudexor"
        "$staging/bin/claudexor" remote probe --json >/dev/null
        printf '%s\\n' "$expected" > "$staging/.archive-sha256"
        if test -e "$destination"; then
          test -d "$destination" && test ! -L "$destination"
          test -f "$destination/.archive-sha256"
          test "$(cat "$destination/.archive-sha256")" = "$expected"
          test -x "$destination/bin/claudexor"
          "$destination/bin/claudexor" remote probe --json >/dev/null
        else
          mv "$staging" "$destination"
        fi
        if test "$expected_current" != "-"; then
          "$root/$expected_current/bin/claudexor" \
            remote stop "$previous_version" "$previous_sha" --json >/dev/null
          test -L "$root/current"
          test "$(readlink "$root/current")" = "$expected_current"
        else
          test ! -e "$root/current"
        fi
        "$destination/bin/claudexor" \
          remote activate "$expected_current" "$candidate" --json >/dev/null
        rm -f "$archive"
        rm -rf "$staging"
        trap - EXIT HUP INT TERM
        rmdir "$lock"
        """

    static let rollbackScript = """
        set -eu
        candidate=$1
        previous=$2
        candidate_version=$3
        candidate_sha=$4
        previous_version=$5
        previous_sha=$6
        case "$candidate" in versions/*) ;; *) exit 64;; esac
        case "$candidate" in */*/*|*..*) exit 64;; esac
        case "$previous" in
          -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
          versions/*)
            case "$previous" in */*/*|*..*) exit 64;; esac
            case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
            case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
            test "${#previous_sha}" -eq 40;;
          *) exit 64;;
        esac
        case "$candidate_version" in *[!0-9.]*|'') exit 64;; esac
        case "$candidate_sha" in *[!0-9a-f]*|'') exit 64;; esac
        test "${#candidate_sha}" -eq 40
        root="$HOME/.claudexor/remote"
        lock="$root/.install-lock"
        umask 077
        if ! mkdir "$lock" 2>/dev/null; then
          echo "another install holds the lock $lock (remove it if no install is running)" >&2
          exit 75
        fi
        cleanup() { rmdir "$lock" 2>/dev/null || true; }
        trap cleanup EXIT HUP INT TERM
        test -L "$root/current"
        test "$(readlink "$root/current")" = "$candidate"
        "$root/$candidate/bin/claudexor" \
          remote stop "$candidate_version" "$candidate_sha" --json >/dev/null
        test -L "$root/current"
        test "$(readlink "$root/current")" = "$candidate"
        "$root/$candidate/bin/claudexor" \
          remote rollback "$candidate" "$previous" --json >/dev/null
        if test "$previous" = "-"; then
          printf '%s\\n' '{"ok":true,"deactivated":true}'
        else
          test -d "$root/$previous"
          test ! -L "$root/$previous"
          "$root/$previous/bin/claudexor" remote bootstrap --json
        fi
        trap - EXIT HUP INT TERM
        rmdir "$lock"
        """
}
