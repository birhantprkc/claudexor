import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The OpenCode vendor-CLI version the remote harness installer pins
 * (issue #89). OpenCode is the one npm-distributed harness with NO recorded
 * stream fixture or verification stamp yet (fixtures are synthetic-only and
 * the fixture-freshness gate discloses that on every run), so unlike the
 * claude/codex constants this pin is NOT a verification claim — it is the
 * deterministic install target: two installs from the same Claudexor build
 * produce the same binary, and npm verifies the registry integrity checksum
 * for this exact version. Bump deliberately; when a live route exists, record
 * a real fixture and stamp it with this same version.
 */
export const OPENCODE_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "1.18.9";
