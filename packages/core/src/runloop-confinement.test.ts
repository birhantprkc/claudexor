import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { buildConfinementProfile } from "./confinement.js";
import { runCliHarness } from "./runloop.js";

/**
 * The seam test. Every local-CLI adapter funnels through `runCliHarness`, so
 * this is where the boundary must be applied — an adapter that had to opt in
 * could forget, and a delegated child would then run on the operator's real
 * home behind a record that claimed confinement.
 */
describe("runCliHarness applies the attempt's confinement", () => {
  const base = mkdtempSync(join(tmpdir(), "cxi-runloop-conf-"));
  const operatorHome = join(base, "operator");
  const runtimeRoot = join(operatorHome, ".claudexor");
  const worktree = join(operatorHome, "project");
  for (const dir of [join(runtimeRoot, "daemon"), join(runtimeRoot, "native"), worktree]) {
    mkdirSync(dir, { recursive: true });
  }
  const token = join(runtimeRoot, "daemon", "token");
  writeFileSync(token, "cxi-daemon-bearer");
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const profile = buildConfinementProfile({
    operatorHome,
    runtimeRoot,
    nativeStateRoot: join(runtimeRoot, "native"),
    scopedHome: join(base, "scoped"),
    worktree,
  });

  async function catToken(confinement: HarnessRunSpec["confinement"]): Promise<HarnessEvent[]> {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-1",
      intent: "implement",
      prompt: "",
      cwd: worktree,
      confinement,
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCliHarness({
      bin: "/bin/cat",
      args: [token],
      spec,
      parseEvent: () => [],
    })) {
      events.push(event);
    }
    return events;
  }

  it.runIf(process.platform === "darwin")(
    "denies the daemon token to the spawned child",
    async () => {
      const confined = await catToken({
        mechanism: "seatbelt",
        profile,
        profile_digest: "sha256:probe",
        verified_denied_path: token,
      });
      const failure = JSON.stringify(confined);
      expect(failure).toMatch(/Operation not permitted/);

      // Same argv, no confinement on the spec: the child reads the token. This is
      // the pre-fix behaviour, kept here so the assertion above cannot pass for a
      // reason unrelated to the boundary.
      const unconfined = await catToken(null);
      expect(JSON.stringify(unconfined)).not.toMatch(/Operation not permitted/);
    },
  );
});
