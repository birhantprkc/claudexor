import { loadConfig } from "@claudexor/config";
import type { QuotaSubject } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";

/** The registered quota-subject universe for each harness's default credential
 * plus every enabled config-directory profile. Missing refresh results remain
 * visible as typed no-source absences because the universe is config-derived. */
export function quotaSubjectUniverseFromConfig(): QuotaSubject[] {
  const profiles = loadConfig(noProjectRepoRoot()).global.credential_profiles;
  const subjects: QuotaSubject[] = [];
  for (const harness of ["claude", "codex"] as const) {
    subjects.push({
      harness,
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: null,
    });
    for (const profile of profiles) {
      if (profile.harness_id !== harness || !profile.enabled) continue;
      if (profile.credential_kind !== "config_dir_login") continue;
      subjects.push({
        harness,
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: profile.profile_id,
      });
    }
  }
  return subjects;
}
