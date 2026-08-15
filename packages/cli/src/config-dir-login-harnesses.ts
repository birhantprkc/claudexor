/**
 * ONE owner for the "this harness supports isolated config-dir/HOME login
 * profiles" fact (INV-122; roast A4, bounded derivation). The four consumer
 * sites — profile registration, the CLI profile-login gate, its configDir
 * resolution, and profile deletion — all read THIS list instead of each
 * hand-maintaining a copy. Membership means: the vendor's native subscription
 * login can be relocated into a Claudexor-owned profile dir
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / the cursor and agy profile HOMEs).
 */
export const CONFIG_DIR_LOGIN_HARNESSES = ["claude", "codex", "cursor", "agy"] as const;
export type ConfigDirLoginHarness = (typeof CONFIG_DIR_LOGIN_HARNESSES)[number];

export function isConfigDirLoginHarness(value: string): value is ConfigDirLoginHarness {
  return (CONFIG_DIR_LOGIN_HARNESSES as readonly string[]).includes(value);
}

/** Human list for error messages ("claude, codex, cursor, agy"). */
export function configDirLoginHarnessList(): string {
  return CONFIG_DIR_LOGIN_HARNESSES.join(", ");
}
