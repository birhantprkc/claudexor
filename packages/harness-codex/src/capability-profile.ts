import {
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  type HarnessCapabilityProfile,
} from "@claudexor/schema";

/** One manifest-owned declaration of the managed login's stdin contract. */
export const CODEX_MANAGED_LOGIN = { stdin: "none" } as const;

export const CODEX_CAPABILITY_PROFILE: HarnessCapabilityProfile =
  HarnessCapabilityProfileSchema.parse({
    auth: {
      supported_sources: ["native_session", "provider_auth_file"],
      preferred_source: null,
      credential_transports: [
        { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
        { source: "provider_auth_file", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
      ],
      managed_login: CODEX_MANAGED_LOGIN,
    },
    access_control: { readonly_mechanism: "fs_sandbox", write_mechanism: "fs_sandbox" },
    isolation: { supported_containment: ["host_user_context", "env_or_file_injection"] },
    mcp_injection: true,
    // Codex's workspace-write seatbelt cancels the belt's daemon-crossing MCP
    // call; only full access lets it through.
    mcp_injection_requires_full_access: true,
    // LIVE-VERIFIED (codex-cli 0.156.1): `turn/steer` injects a user message
    // into the ACTIVE turn and the app-server echoes it as a userMessage item
    // carrying our clientId (fixtures/app-server/recorded-steer-0.156.1.jsonl).
    live_input: "mid_turn",
    attachment_inputs: [
      {
        kind: "image",
        mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        max_bytes: 20 * 1024 * 1024,
        max_count: 20,
        transport: "file_path",
      },
    ],
  });
