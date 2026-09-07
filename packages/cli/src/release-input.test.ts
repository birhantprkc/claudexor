import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const verifier = resolve(repo, "scripts/verify-release-input.mjs");

/** The ambient env with every workflow-projected release input cleared. The
 * publish workflow itself runs this suite in its deterministic gates, so a
 * live `SKIP_CUSTOM_ED25519_INPUT=true` (or any other projected input) would
 * otherwise leak into cases that assert a DIFFERENT input combination — the
 * suite must pin the whole surface it is testing, never inherit it. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "RELEASE_MODE_INPUT",
    "RELEASE_REF_INPUT",
    "REVIEW_ATTESTATION_B64_INPUT",
    "REVIEW_URL_INPUT",
    "REVIEW_CONFIRMED_INPUT",
    "WAIVE_CURSOR_REVIEW_INPUT",
    "RUNTIME_MANIFEST_B64_INPUT",
    "REMOTE_RUNTIME_MANIFEST_B64_INPUT",
    "SKIP_CUSTOM_ED25519_INPUT",
    "CANDIDATE_RUN_ID_INPUT",
    "GITHUB_SHA",
    "GITHUB_REF",
  ]) {
    delete env[key];
  }
  return env;
}

function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

type PublishFixture = {
  candidateSha: string;
  fixture: string;
  tag: string;
};

function withPublishFixture(version: string, run: (fixture: PublishFixture) => void): void {
  const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: fixture,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  const tag = `v${version}`;
  try {
    git("init", "-q");
    writeFileSync(resolve(fixture, "package.json"), `${JSON.stringify({ version })}\n`);
    git("add", "package.json");
    git("commit", "-qm", "fixture");
    git("tag", "-a", tag, "-m", "fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture,
      encoding: "utf8",
    }).trim();
    run({ candidateSha, fixture, tag });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function verifyPublish(
  fixture: PublishFixture,
  overrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifier], {
    cwd: fixture.fixture,
    encoding: "utf8",
    env: {
      ...baseEnv(),
      GITHUB_SHA: fixture.candidateSha,
      GITHUB_REF: `refs/tags/${fixture.tag}`,
      RELEASE_MODE_INPUT: "publish",
      RELEASE_REF_INPUT: fixture.tag,
      REVIEW_URL_INPUT: "https://github.com/example/project/pull/42#issuecomment-99",
      REVIEW_CONFIRMED_INPUT: "true",
      WAIVE_CURSOR_REVIEW_INPUT: "false",
      RUNTIME_MANIFEST_B64_INPUT: "e30=",
      REMOTE_RUNTIME_MANIFEST_B64_INPUT: "e30=",
      SKIP_CUSTOM_ED25519_INPUT: "false",
      ...overrides,
    },
  });
}

describe("candidate release input", () => {
  it("accepts only the exact workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: candidateSha,
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`release input OK: candidate ${candidateSha}`);
  });

  it("rejects a resolvable candidate that differs from the workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: "0".repeat(40),
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release input rejected: candidate SHA does not match the workflow-dispatch GITHUB_SHA",
    );
  });

  it("rejects a publish tag when its commit differs from the workflow-dispatch SHA", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(resolve(fixture, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      git("tag", "-a", "v2.0.0", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      const result = spawnSync(process.execPath, [verifier], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          GITHUB_SHA: "0".repeat(40),
          GITHUB_REF: "refs/tags/v2.0.0",
          RELEASE_MODE_INPUT: "publish",
          RELEASE_REF_INPUT: "v2.0.0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish SHA does not match the workflow-dispatch GITHUB_SHA",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects publish from a branch ref before release work can start", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(resolve(fixture, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      git("tag", "-a", "v2.0.0", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture,
        encoding: "utf8",
      }).trim();

      const result = spawnSync(process.execPath, [verifier], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          GITHUB_SHA: candidateSha,
          GITHUB_REF: "refs/heads/main",
          RELEASE_MODE_INPUT: "publish",
          RELEASE_REF_INPUT: "v2.0.0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish workflow must be dispatched from the exact release tag ref",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("maintainer-confirmed independent review", () => {
  it.each(["3.8.0", "3.9.8", "4.0.0"])(
    "accepts the same current policy for version %s, without a signed review or model list",
    (version) =>
      withPublishFixture(version, (fixture) => {
        const result = verifyPublish(fixture);
        expect(result.status, String(result.stderr)).toBe(0);
      }),
  );
  it.each(["", "false", "1"])("requires explicit responsible confirmation (%s)", (confirmation) => {
    withPublishFixture("3.9.8", (fixture) => {
      const result = verifyPublish(fixture, { REVIEW_CONFIRMED_INPUT: confirmation });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("review_confirmed");
    });
  });
  it.each(["", "not a url", "http://example.org/review", "https://user:pass@example.org/review"])(
    "rejects invalid or credential-bearing evidence URL %s",
    (url) => {
      withPublishFixture("3.9.8", (fixture) => {
        const result = verifyPublish(fixture, { REVIEW_URL_INPUT: url });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("review_url");
      });
    },
  );
  it("permits a private CI artifact reference without a hosting allowlist", () => {
    withPublishFixture("3.9.8", (fixture) => {
      expect(
        verifyPublish(fixture, { REVIEW_URL_INPUT: "https://ci.example.org/build/42/artifacts" })
          .status,
      ).toBe(0);
    });
  });
  it.each(["SKIP_CUSTOM_ED25519_INPUT", "WAIVE_CURSOR_REVIEW_INPUT"])(
    "retired %s cannot bypass the current policy even for historical versions",
    (name) => {
      withPublishFixture("3.8.0", (fixture) => {
        const result = verifyPublish(fixture, { [name]: "true" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("retired");
      });
    },
  );
  it("does not accept an old signed review instead of confirmation", () => {
    withPublishFixture("3.9.8", (fixture) => {
      const result = verifyPublish(fixture, { REVIEW_ATTESTATION_B64_INPUT: "e30=" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("historical evidence");
    });
  });
  it.each(["RUNTIME_MANIFEST_B64_INPUT", "REMOTE_RUNTIME_MANIFEST_B64_INPUT"])(
    "keeps %s mandatory independently of review",
    (name) => {
      withPublishFixture("3.9.8", (fixture) => {
        for (const value of ["", "not base64"]) {
          const result = verifyPublish(fixture, { [name]: value });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(name);
        }
      });
    },
  );
});
