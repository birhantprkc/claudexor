/**
 * Which harnesses have a DEFAULT credential store — a place a vendor login
 * lands when no named account is selected.
 *
 * Every harness Claudexor drives does except agy: the Antigravity CLI takes
 * its whole config root from `$HOME` and exposes no config-dir variable, so
 * adopting a default store would mean adopting the operator's real home
 * directory as a credential store (owner decision Л-4). A harness that answers
 * false can only sign in INTO a named account, and every surface offering a
 * default login must refuse rather than pick one for the user.
 */
export function harnessHasDefaultCredentialStore(harness: string): boolean {
  return harness !== "agy";
}
