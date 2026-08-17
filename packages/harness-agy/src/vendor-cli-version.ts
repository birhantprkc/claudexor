import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The Antigravity CLI (`agy`) version this adapter's recorded fixtures,
 * manifest `known_models` list, and file-token-fallback proof were captured
 * against. Unlike the claude/codex constants this is NOT an npm install pin —
 * agy ships as a closed Google binary with no npm artifact (the installer
 * uses the vendor's official script, cursor-style, `human_observed`). It IS
 * the verification stamp: `known_models_verified_against` reads it, fixture
 * provenance records it, and the doctor discloses drift when the installed
 * binary self-updates past it. The profile file-token fallback (the whole
 * multi-account mechanism) is re-proven per bump of this constant — it is a
 * vendor ERROR path, not a documented mode (PLAN Л-15/R-2').
 */
export const AGY_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "1.1.13";
