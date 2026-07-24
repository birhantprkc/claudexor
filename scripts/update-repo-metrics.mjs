#!/usr/bin/env node
// Repo metrics collector (D-15). Dependency-free Node stdlib only.
//
// Appends a daily download-total row to docs/assets/repo-metrics.csv and renders
// a Shields endpoint badge. Runs from the daily repo-metrics workflow (or
// locally with a network + optional GITHUB_TOKEN).
//
// Honesty rules baked in here:
//   - The headline metric is "total downloads" = top-level npm package
//     downloads + the raw cumulative count across ALL uploaded GitHub release
//     assets. It is a download-event count, never an installation claim.
//   - npm_total is SEEDED once from the package's lifetime point range (the
//     package is younger than the npm 18-month range cap), then extended by
//     idempotent daily deltas summed from the npm daily range since the last
//     fully closed UTC day. It is never recomputed from scratch, and a rerun on
//     the same day reuses the closed-day watermark while refreshing GitHub.
//   - github_release_downloads is the current raw cumulative sum from the
//     GitHub releases API (that endpoint reports live cumulative counts).
//   - A source that fails is surfaced loudly; we never write a fabricated zero.
//
// Usage:
//   node scripts/update-repo-metrics.mjs          # fetch + write CSV/badge
//   node scripts/update-repo-metrics.mjs --check   # offline pure self-tests

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpsGet } from "node:https";

// Single shared collector / asset-authority (D-15 reuse-lock; audit A-6). This
// same module backs the CLI `claudexor release stats`, so release-asset totals,
// npm daily-delta math, and the CSV ledger logic have exactly ONE definition.
// Imported unbuilt via Node's native
// TypeScript type stripping (the workflow runs plain `node`; .node-version pins
// the type-stripping runtime) — so this file stays dependency-free and only
// network/file IO and orchestration live here.
import {
  computeReleaseAssetTotals,
  hasMoreReleasePages,
  sumNpmDeltaAfter,
  utcDate,
  addDaysUtc,
  parseCsv,
  serializeCsv,
  upsertRow,
  latestRowAtOrBefore,
  formatThousands,
} from "../packages/cli/src/repo-asset-authority.ts";

const REPO = "razzant/claudexor";
const NPM_PACKAGE = "claudexor";
// npm registry "created" time for the package; the lifetime point range starts
// here. GitHub v1.0.0 predates the first npm publish (v1.0.1) by a day; npm is
// the seed authority for the npm column.
const NPM_FIRST_PUBLISH = "2026-07-10";
const USER_AGENT = "claudexor-repo-metrics (+https://github.com/razzant/claudexor)";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const assetsDir = join(repoRoot, "docs", "assets");
const csvPath = join(assetsDir, "repo-metrics.csv");
const badgePath = join(assetsDir, "downloads-badge.json");

// Release-asset totals, npm daily-delta math, CSV helpers, pagination, and
// number formatting live in the shared authority. Only network/file IO and
// orchestration remain here.

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (url.includes("api.github.com") && process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    httpsGet(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`GET ${url} -> HTTP ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`GET ${url} -> invalid JSON (${err.message})`));
        }
      });
    }).on("error", (err) => reject(new Error(`GET ${url} -> ${err.message}`)));
  });
}

async function fetchAllReleases() {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await fetchJson(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (!hasMoreReleasePages(batch)) break;
  }
  return releases;
}

async function fetchNpmRange(from, to) {
  const data = await fetchJson(
    `https://api.npmjs.org/downloads/range/${from}:${to}/${NPM_PACKAGE}`,
  );
  if (!Array.isArray(data?.downloads)) throw new Error("npm range API returned no downloads array");
  if (data.end !== to || !data.downloads.some((point) => point?.day === to)) {
    throw new Error(`npm range API has not finalized ${to}`);
  }
  return data.downloads;
}

async function fetchNpmLifetime(to) {
  const data = await fetchJson(
    `https://api.npmjs.org/downloads/point/${NPM_FIRST_PUBLISH}:${to}/${NPM_PACKAGE}`,
  );
  if (typeof data?.downloads !== "number") throw new Error("npm point API returned no downloads");
  if (data.end !== to) throw new Error(`npm point API has not finalized ${to}`);
  return data.downloads;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const today = utcDate();
  const npmThrough = addDaysUtc(today, -1);

  const existing = existsSync(csvPath) ? parseCsv(readFileSync(csvPath, "utf8")).rows : [];
  const prior = latestRowAtOrBefore(existing, today);

  const releases = await fetchAllReleases();
  const githubReleaseDownloads = computeReleaseAssetTotals(releases).rawTotalDownloads;

  let npmTotal;
  if (prior === null) {
    // First ever row: seed only through the latest fully closed UTC day.
    npmTotal = await fetchNpmLifetime(npmThrough);
  } else if (prior.npm_through === npmThrough) {
    // Same-day rerun: npm is unchanged; only GitHub's live cumulative total moves.
    npmTotal = prior.npm_total;
  } else if (prior.npm_through < npmThrough) {
    // Extend from the persisted closed-day watermark. A missed cron window is
    // recovered by the whole range tail, never by trusting a provisional day.
    const daily = await fetchNpmRange(addDaysUtc(prior.npm_through, 1), npmThrough);
    npmTotal = prior.npm_total + sumNpmDeltaAfter(daily, prior.npm_through, npmThrough);
  } else {
    throw new Error(`npm watermark ${prior.npm_through} is after target ${npmThrough}`);
  }

  const totalDownloads = npmTotal + githubReleaseDownloads;
  const row = {
    date: today,
    npm_through: npmThrough,
    npm_total: npmTotal,
    github_release_downloads: githubReleaseDownloads,
    total_downloads: totalDownloads,
  };

  const rows = upsertRow(existing, row);

  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  writeFileSync(csvPath, serializeCsv(rows));

  const badge = {
    schemaVersion: 1,
    label: "total downloads",
    message: formatThousands(totalDownloads),
    color: "blue",
  };
  writeFileSync(badgePath, `${JSON.stringify(badge, null, 2)}\n`);

  console.log(
    `repo-metrics ${today}: npm_through=${npmThrough} npm_total=${npmTotal} ` +
      `github_release_downloads=${githubReleaseDownloads} total_downloads=${totalDownloads}`,
  );
}

// ---------------------------------------------------------------------------
// Self-tests (--check): pure logic only, no network, no writes.
// ---------------------------------------------------------------------------

function runSelfTests() {
  let failures = 0;
  const ok = (cond, msg) => {
    if (!cond) {
      failures++;
      console.error(`FAIL: ${msg}`);
    }
  };
  const throws = (fn, msg) => {
    try {
      fn();
      ok(false, msg);
    } catch {
      ok(true, msg);
    }
  };

  // 1. The README total uses every uploaded release asset, through the same
  // shared authority as `release stats`.
  const gh = computeReleaseAssetTotals([
    {
      assets: [
        { name: "Claudexor-3.0.4.dmg", download_count: 69 },
        { name: "Claudexor-3.0.4.zip", download_count: 42 },
        { name: "claudexor-runtime-3.0.4.tar.gz", download_count: 999 },
        { name: "SHA256SUMS", download_count: 4 },
      ],
    },
    {
      assets: [
        { name: "Claudexor-3.0.3.dmg", download_count: 16 },
        { name: "Claudexor-3.0.3.zip", download_count: 7 },
      ],
    },
  ]);
  ok(gh.appInstallerDownloads === 69 + 42 + 16 + 7, "app subtotal remains available");
  ok(
    gh.rawTotalDownloads === 69 + 42 + 999 + 4 + 16 + 7,
    "README total includes every uploaded release asset",
  );

  // 2. CSV idempotency: same day upsert -> one row, updated value.
  let rows = [];
  rows = upsertRow(rows, {
    date: "2026-07-23",
    npm_through: "2026-07-22",
    npm_total: 1250,
    github_release_downloads: 700,
    total_downloads: 1950,
  });
  rows = upsertRow(rows, {
    date: "2026-07-23",
    npm_through: "2026-07-22",
    npm_total: 1250,
    github_release_downloads: 710,
    total_downloads: 1960,
  });
  ok(rows.length === 1, "same-day rerun does not duplicate rows");
  ok(rows[0].github_release_downloads === 710, "same-day rerun refreshes GitHub");
  rows = upsertRow(rows, {
    date: "2026-07-22",
    npm_through: "2026-07-21",
    npm_total: 0,
    github_release_downloads: 0,
    total_downloads: 0,
  });
  ok(rows[0].date === "2026-07-22", "rows stay sorted by date");

  const round1 = serializeCsv(rows);
  const round2 = serializeCsv(parseCsv(round1).rows);
  ok(round1 === round2, "CSV serialize/parse round-trips");

  // 3. The npm watermark is the last CLOSED day. A 07-23 seed through 07-22
  // must collect the 61 downloads that finalize for 07-23 on the next run.
  const prior = latestRowAtOrBefore(rows, "2026-07-23");
  ok(prior && prior.date === "2026-07-23", "same-day rerun reuses the latest row");
  const delta = sumNpmDeltaAfter(
    [
      { day: "2026-07-22", downloads: 180 },
      { day: "2026-07-23", downloads: 61 },
    ],
    "2026-07-22",
    "2026-07-23",
  );
  ok(1250 + delta === 1311, "closed-day delta repairs the provisional seed");

  // 4. Malformed persisted state fails loudly instead of poisoning all future
  // cumulative totals with NaN or a mismatched arithmetic result.
  throws(() => parseCsv("date,npm_total\n2026-07-23,1250\n"), "CSV rejects a stale header");
  throws(
    () =>
      parseCsv(
        "date,npm_through,npm_total,github_release_downloads,total_downloads\n" +
          "2026-07-23,2026-07-22,1250,700,9999\n",
      ),
    "CSV rejects an inconsistent total",
  );

  // 5. Formatting.
  ok(formatThousands(2078) === "2,078", "thousands separator");
  ok(formatThousands(226) === "226", "no separator under 1000");

  if (failures > 0) {
    console.error(`repo-metrics self-test: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("repo-metrics self-test: all checks passed");
}

const arg = process.argv[2];
if (arg === "--check") {
  runSelfTests();
} else {
  main().catch((err) => {
    console.error(`repo-metrics failed: ${err.message}`);
    process.exit(1);
  });
}
