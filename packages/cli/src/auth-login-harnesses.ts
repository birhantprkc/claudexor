import { ControlHarnessSetupHarness, harnessHasDefaultCredentialStore } from "@claudexor/schema";

/**
 * `claudexor auth login` signs in the DEFAULT account, so a harness with no
 * default credential store never belongs here: its accounts are all named
 * profiles and `claudexor profiles login <harness> <id>` is the working verb.
 * Deriving both the gate and the usage text from one place keeps the CLI from
 * offering a command the daemon can only refuse.
 */
export function isKnownAuthLoginHarness(harness: string): boolean {
  return (
    ControlHarnessSetupHarness.safeParse(harness).success &&
    harnessHasDefaultCredentialStore(harness)
  );
}

/** The harnesses `auth login` accepts, for its own usage strings. */
export function authLoginHarnessList(): string {
  return ControlHarnessSetupHarness.options.filter(harnessHasDefaultCredentialStore).join("|");
}
