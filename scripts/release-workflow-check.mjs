#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";

// Generic hygiene (SHA-pinned action refs, no GitHub-expression injection into
// shell) is enforced across EVERY workflow, not just ci.yml/release.yml (audit
// A-7: pages.yml and the repo-metrics writer must be pinned too). The
// release-specific semantic assertions below still read release.yml directly.
const workflowDir = ".github/workflows";
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort()
  .map((name) => `${workflowDir}/${name}`);
const errors = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
    const action = match[1];
    if (!/@[0-9a-f]{40}$/.test(action))
      errors.push(`${file}: action is not pinned to a full SHA: ${action}`);
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(\s*)run:/.exec(lines[index]);
    if (!run) continue;
    if (lines[index].includes("${{")) {
      errors.push(`${file}: GitHub expression is interpolated directly into a shell run line`);
    }
    if (!/run:\s*[>|]\s*$/.test(lines[index])) continue;
    const indent = run[1].length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.length - line.trimStart().length <= indent) {
        index -= 1;
        break;
      }
      if (line.includes("${{")) {
        errors.push(`${file}: GitHub expression is interpolated directly into a shell run block`);
      }
    }
  }
}

const release = readFileSync(".github/workflows/release.yml", "utf8");
const publishMcp = readFileSync(".github/workflows/publish-mcp.yml", "utf8");
const prepareJob = jobBody(release, "prepare");
const packageMacosJob = jobBody(release, "package-macos");
const publishNpmJob = jobBody(release, "publish-npm");
const publishReleaseJob = jobBody(release, "publish-release");
for (const [label, pattern] of [
  ["workflow has candidate mode", /candidate/],
  ["workflow has publish mode", /publish/],
  ["review attestation is verified", /verify-release-input\.mjs/],
  [
    // validateReleaseAttestation rejects any non-v3 attestation, so the
    // workflow_dispatch input must document the schema owners actually sign.
    "attestation input is documented as a schema-v4 owner-review attestation",
    /review_attestation_b64:\s*\n\s*description:[^\n]*schema-v4 owner-review attestation/,
  ],
  ["npm provenance is mandatory", /--provenance/],
  [
    "installed npm daemon wrapper serves the scoped delegation belt",
    /smoke-delegation-belt-entry\.mjs[\s\S]*?node_modules\/\.bin\/claudexord/,
  ],
  ["artifact provenance is emitted", /actions\/attest-build-provenance@[0-9a-f]{40}/],
  ["signing is fail-closed", /Signing and notarization secrets are required/],
  ["release assets use collision checks", /Release asset collision/],
  ["Darwin npm tarball is smoke-tested", /verify-npm-darwin-package\.mjs --tarball/],
  [
    "SBOM inventories the packaged app",
    /generate-release-sbom\.mjs\s+\\\s*\n\s*--app-bundle apps\/macos\/dist\/Claudexor\.app/,
  ],
  ["engine runtime update closure is built (M7)", /build-runtime-closure\.mjs/],
  [
    "runtime closure is built from the signed app bundle",
    /build-runtime-closure\.mjs\s+\\\s*\n\s*--app-bundle apps\/macos\/dist\/Claudexor\.app/,
  ],
  [
    "runtime manifest digest is self-verified before upload",
    /runtime manifest sha256 does not match the tarball/,
  ],
  [
    "runtime closure tarball ships as a release asset",
    /cp "\$RUNNER_TEMP\/runtime-closure\/claudexor-runtime-\$VERSION\.tar\.gz" "\$assets\/"/,
  ],
  [
    "candidate runtime manifest ships as a release asset",
    /cp "\$RUNNER_TEMP\/runtime-closure\/runtime-manifest\.json" "\$assets\/"/,
  ],
  [
    // D-2: publish must verify the owner-signed manifest fail-closed before it
    // ships (pinned-authority signature + promoted-artifact byte-identity).
    "publish verifies the owner-signed runtime manifest",
    /verify-signed-runtime-manifest\.mjs/,
  ],
  [
    "signed runtime manifest input is documented for publish",
    /runtime_manifest_b64:\s*\n\s*description:[^\n]*owner-signed runtime-update manifest/,
  ],
  [
    // A-5: publish must PROMOTE the exact candidate artifact bytes, not rebuild.
    "candidate run id input is documented for publish promotion",
    /candidate_run_id:\s*\n\s*description:[^\n]*promotes/,
  ],
  [
    "publish downloads the promoted candidate artifact by run id",
    /download-artifact@[0-9a-f]{40}[\s\S]*?run-id:\s*\$\{\{\s*needs\.prepare\.outputs\.candidate_run_id\s*\}\}/,
  ],
  [
    "publish verifies every promoted candidate asset provenance",
    /for file in candidate-assets\/\*; do[\s\S]*?gh attestation verify "\$file"/,
  ],
  [
    "publish promotes the candidate closure bytes rather than rebuilding",
    /cp "\$cand" "\$tarball"/,
  ],
]) {
  if (!pattern.test(release)) errors.push(`release.yml: ${label}`);
}
errors.push(...exactCandidateAppPromotionErrors(packageMacosJob));
for (const [label, broken] of [
  [
    "candidate-only signing guard",
    packageMacosJob.replace(
      "- name: Require and import Apple release credentials\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Require and import Apple release credentials\n        if: always()",
    ),
  ],
  [
    "unconditional release Node pin",
    packageMacosJob.replace(
      "- name: Pin release Node runtime\n        shell: bash",
      "- name: Pin release Node runtime\n        if: needs.prepare.outputs.mode == 'candidate'\n        shell: bash",
    ),
  ],
  [
    "candidate-only build guard",
    packageMacosJob.replace(
      "- name: Build signed DMG and ZIP\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Build signed DMG and ZIP\n        if: always()",
    ),
  ],
  [
    "candidate-only fresh verification guard",
    packageMacosJob.replace(
      "- name: Verify signed and notarized artifacts\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Verify signed and notarized artifacts\n        if: always()",
    ),
  ],
  [
    "candidate DMG source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.dmg" "$assets/"',
    ),
  ],
  [
    "candidate ZIP source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.zip" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.zip" "$assets/"',
    ),
  ],
  [
    "candidate SBOM source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.spdx.json" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.spdx.json" "$assets/"',
    ),
  ],
  [
    "candidate SBOM prepared-SHA binding",
    replaceLastOccurrence(
      packageMacosJob,
      'GITHUB_SHA="$PREPARED_SHA" pnpm licenses list --prod --json',
      "pnpm licenses list --prod --json",
    ),
  ],
  [
    "candidate run SHA binding",
    packageMacosJob.replace('test "$run_sha" = "$PREPARED_SHA"', 'test -n "$run_sha"'),
  ],
  [
    "candidate provenance source binding",
    `${packageMacosJob.replace('--source-digest "$PREPARED_SHA"', "--source-digest unknown")}\n# --source-digest "$PREPARED_SHA"`,
  ],
  [
    "provenance-before-checksum order",
    packageMacosJob.replace(
      "for file in candidate-assets/*; do",
      "(cd candidate-assets && shasum -a 256 -c SHA256SUMS)\n          for file in candidate-assets/*; do",
    ),
  ],
  [
    "candidate daemon version probe",
    packageMacosJob.replace("probe.version !== process.argv[2]", "false"),
  ],
  [
    "candidate daemon build-SHA probe",
    packageMacosJob.replace("probe.buildSha !== process.argv[3]", "false"),
  ],
  [
    "isolated belt smoke HOME",
    packageMacosJob.replace(
      'HOME="$promoted_belt_home" node scripts/smoke-delegation-belt-entry.mjs',
      "node scripts/smoke-delegation-belt-entry.mjs",
    ),
  ],
  [
    "publish assembly step scoping",
    `${packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.dmg" "$assets/"',
    )}\n# cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"`,
  ],
]) {
  if (exactCandidateAppPromotionErrors(broken).length === 0) {
    errors.push(`release-workflow-check self-test: failed to reject missing ${label}`);
  }
}
if (!/^\s+ref:\s*\$\{\{\s*github\.sha\s*\}\}\s*$/m.test(prepareJob)) {
  errors.push(
    "release.yml: prepare checkout must use the immutable workflow-dispatch github.sha (never hardcoded main)",
  );
}
if (!/^\s{4}runs-on:\s*macos-26\s*$/m.test(publishNpmJob)) {
  errors.push("release.yml: npm publication must run on macos-26");
}
const beforeAssets = publishReleaseJob.indexOf("--phase before");
const uploadAssets = publishReleaseJob.indexOf('gh release upload "$TAG" "$file"');
const afterAssets = publishReleaseJob.indexOf("--phase after");
const publishDraft = publishReleaseJob.indexOf('gh release edit "$TAG" --draft=false --latest');
if (!(beforeAssets >= 0 && beforeAssets < uploadAssets)) {
  errors.push("release.yml: remote asset subset must be verified before upload");
}
if (!(uploadAssets >= 0 && uploadAssets < afterAssets && afterAssets < publishDraft)) {
  errors.push(
    "release.yml: exact remote asset set must be verified after upload and before publish",
  );
}
if (/gh\s+release\s+delete-asset/.test(publishReleaseJob)) {
  errors.push("release.yml: retry flow must never delete unexpected remote assets");
}

const coreManifest = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
if (
  coreManifest.bin?.["claudexor-process-identity"] !== "./dist/native/claudexor-process-identity"
) {
  errors.push("packages/core/package.json: Darwin helper must be an executable npm bin entry");
}
if (!String(coreManifest.scripts?.prepack ?? "").includes("verify-npm-darwin-package.mjs")) {
  errors.push("packages/core/package.json: Darwin helper prepack verification is missing");
}
const npmPublisher = readFileSync("scripts/publish-npm-release.mjs", "utf8");
const verifyDarwinPackage = npmPublisher.indexOf("verify-npm-darwin-package.mjs");
const verifyClaudexorPackage = npmPublisher.indexOf("verify-npm-claudexor-package.mjs");
const smokePackedDelegationBelt = npmPublisher.indexOf("smokePackedDelegationBelt(packed");
const publishTarball = npmPublisher.indexOf('"publish"');
if (verifyDarwinPackage < 0 || publishTarball < 0 || verifyDarwinPackage > publishTarball) {
  errors.push("publish-npm-release.mjs: Darwin package verification must precede npm publish");
}
if (verifyClaudexorPackage < 0 || publishTarball < 0 || verifyClaudexorPackage > publishTarball) {
  errors.push(
    "publish-npm-release.mjs: Claudexor MCP package verification must precede npm publish",
  );
}
if (
  smokePackedDelegationBelt < 0 ||
  publishTarball < 0 ||
  smokePackedDelegationBelt > publishTarball
) {
  errors.push(
    "publish-npm-release.mjs: exact packed delegation belt smoke must precede npm publish",
  );
}
for (const [label, pattern] of [
  ["published provenance is bound to source identity", /validatePublishedProvenance/],
  ["published latest dist-tag is verified", /dist-tags.*latest/s],
  ["published package signatures are audited", /audit[",\s]+signatures/],
]) {
  if (!pattern.test(npmPublisher)) errors.push(`publish-npm-release.mjs: ${label}`);
}

const verifier = readFileSync("scripts/verify-release-input.mjs", "utf8");
if (!/validateReleaseAttestation\(attestation, reviewAuthority/.test(verifier)) {
  errors.push("verify-release-input.mjs: signed review authority is not checked before publish");
}
if (!/GITHUB_REF[\s\S]*refs\/tags\/\$\{tag\}/.test(verifier)) {
  errors.push(
    "verify-release-input.mjs: publish mode must require workflow dispatch from the exact tag ref",
  );
}
const authority = JSON.parse(readFileSync("release/review-attestation-authority.json", "utf8"));
if (
  authority.algorithm !== "Ed25519" ||
  !/^claudexor-v2\.0\.0-review-ed25519-[0-9a-f]{16}$/.test(authority.keyId ?? "") ||
  !String(authority.publicKeyPem ?? "").includes("BEGIN PUBLIC KEY")
) {
  errors.push("release/review-attestation-authority.json: invalid pinned Ed25519 authority");
}
// D-2: the runtime-update authority is a SEPARATE pinned Ed25519 key (never the
// review key) with the runtime-update keyId shape.
const runtimeAuthority = JSON.parse(readFileSync("release/runtime-update-authority.json", "utf8"));
if (
  runtimeAuthority.algorithm !== "Ed25519" ||
  !/^claudexor-runtime-update-[0-9a-z.-]+-ed25519-[0-9a-f]{16}$/.test(
    runtimeAuthority.keyId ?? "",
  ) ||
  !String(runtimeAuthority.publicKeyPem ?? "").includes("BEGIN PUBLIC KEY")
) {
  errors.push("release/runtime-update-authority.json: invalid pinned Ed25519 authority");
}
if (
  runtimeAuthority.keyId === authority.keyId ||
  runtimeAuthority.publicKeyPem === authority.publicKeyPem
) {
  errors.push(
    "release/runtime-update-authority.json: must be a SEPARATE key from the review authority",
  );
}
for (const [label, pattern] of [
  ["--clobber is forbidden", /--clobber/],
  ["unsigned release fallback is forbidden", /continue-on-error:\s*true/],
  ["runtime package downloads are forbidden", /\bnpx\b|@latest/],
  ["tag-push publication is forbidden", /^\s*push:\s*\n\s*tags:/m],
  // The attestation is schema v4; stale v2/v3 wording must never return.
  ["stale schema-v2 attestation wording is forbidden", /schema-v2/],
]) {
  if (pattern.test(release)) errors.push(`release.yml: ${label}`);
}

for (const [label, pattern] of [
  ["manual tag input is required", /workflow_dispatch:[\s\S]*?tag:[\s\S]*?required:\s*true/],
  ["GitHub OIDC permission is required", /id-token:\s*write/],
  [
    "tag input is bound to the root package version",
    /root_version=.*package\.json[\s\S]*expected_tag="v\$root_version"[\s\S]*test "\$MCP_TAG_INPUT" = "\$expected_tag"/,
  ],
  ["tag dispatch is bound to GITHUB_REF", /GITHUB_REF[\s\S]*refs\/tags\/\$MCP_TAG_INPUT/],
  ["annotated release tag is required", /git cat-file -e "\$MCP_TAG_INPUT\^\{tag\}"/],
  ["tag commit must be on origin main", /git merge-base --is-ancestor/],
  ["npm MCP metadata is verified", /mcp-registry-check\.mjs --npm/],
  [
    "publisher download is version pinned",
    /releases\/download\/v1\.8\.0\/mcp-publisher_linux_amd64\.tar\.gz/,
  ],
  [
    "publisher archive checksum is pinned",
    /1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf/,
  ],
  ["publisher validates server metadata", /\.\/mcp-publisher validate/],
  ["registry preflight is idempotent", /mcp-registry-check\.mjs --registry before/],
  ["registry uses GitHub OIDC", /\.\/mcp-publisher login github-oidc/],
  ["registry publishes metadata", /\.\/mcp-publisher publish/],
  ["registry publication is confirmed", /mcp-registry-check\.mjs --registry after/],
]) {
  if (!pattern.test(publishMcp)) errors.push(`publish-mcp.yml: ${label}`);
}
for (const [label, pattern] of [
  ["tag-push trigger is forbidden", /^\s*push:\s*$/m],
  ["floating publisher download is forbidden", /releases\/latest|@latest/],
  [
    "long-lived registry tokens are forbidden",
    /MCP_GITHUB_TOKEN|MCP_REGISTRY_TOKEN|\$\{\{\s*secrets\./,
  ],
  ["failure bypass is forbidden", /continue-on-error:\s*true/],
]) {
  if (pattern.test(publishMcp)) errors.push(`publish-mcp.yml: ${label}`);
}

const mcpPackage = JSON.parse(readFileSync("packages/claudexor/package.json", "utf8"));
const mcpServer = JSON.parse(readFileSync("server.json", "utf8"));
if (mcpPackage.mcpName !== "io.github.razzant/claudexor") {
  errors.push("packages/claudexor/package.json: unexpected mcpName");
}
if (
  mcpServer.name !== mcpPackage.mcpName ||
  mcpServer.packages?.length !== 1 ||
  mcpServer.packages[0]?.identifier !== "claudexor" ||
  JSON.stringify(mcpServer.packages[0]?.packageArguments) !==
    JSON.stringify([
      { type: "positional", value: "mcp" },
      { type: "positional", value: "serve" },
    ])
) {
  errors.push("server.json: executable npm MCP identity or package arguments drifted");
}

const directInputs = [...release.matchAll(/\$\{\{\s*inputs\.[^}]+\}\}/g)].map((match) => match[0]);
if (directInputs.length !== 5) {
  errors.push(
    `release.yml: expected exactly five input projections into workflow env, got ${directInputs.length}`,
  );
}
if (errors.length) {
  for (const error of errors) console.error(`release workflow check failed: ${error}`);
  process.exit(1);
}
console.log("release workflow check OK");

function jobBody(workflow, name) {
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start < 0) {
    errors.push(`release.yml: missing ${name} job`);
    return "";
  }
  const next = workflow.slice(start + 2).search(/^  [a-z0-9-]+:\n/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}

function exactCandidateAppPromotionErrors(job) {
  const findings = [];
  const candidateVerifyStep = stepBody(job, "Verify signed and notarized artifacts");
  const verifyStep = stepBody(job, "Verify promoted candidate app artifacts (publish, A-5)");
  const assembleStep = stepBody(job, "Assemble checksums, SBOM and review evidence");
  const requirePattern = (label, pattern, scope = job) => {
    if (!pattern.test(scope)) findings.push(`release.yml: ${label}`);
  };
  requirePattern(
    "release Node runtime must be pinned unconditionally",
    /- name: Pin release Node runtime\n\s+shell: bash\n\s+run: echo "CLAUDEXOR_NODE_BIN=\$\(node -p 'process\.execPath'\)" >> "\$GITHUB_ENV"/,
  );
  requirePattern(
    "app signing credential import must be candidate-only",
    /- name: Require and import Apple release credentials\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'/,
  );
  requirePattern(
    "signed app build must be candidate-only",
    /- name: Build signed DMG and ZIP\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'[\s\S]*?apps\/macos\/scripts\/build-app\.sh/,
  );
  requirePattern(
    "fresh app verification must be candidate-only",
    /- name: Verify signed and notarized artifacts\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'/,
  );
  requirePattern(
    "candidate ZIP app must probe the exact daemon version and build SHA before upload",
    /PREPARED_SHA:[\s\S]*?ditto -x -k "\$zip"[\s\S]*?claudexord\.bundle\.cjs" --probe[\s\S]*?probe\.version !== process\.argv\[2\][\s\S]*?probe\.buildSha !== process\.argv\[3\][\s\S]*?"\$probe" "\$VERSION" "\$PREPARED_SHA"/,
    candidateVerifyStep,
  );
  requirePattern(
    "candidate run must bind the release workflow, exact SHA, and successful conclusion",
    /test "\$run_path" = "\.github\/workflows\/release\.yml"[\s\S]*?test "\$run_sha" = "\$PREPARED_SHA"[\s\S]*?test "\$run_conclusion" = success/,
    verifyStep,
  );
  requirePattern(
    "candidate provenance must bind signer workflow and source digest",
    /gh attestation verify "\$file"[\s\S]*?--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml"[\s\S]*?--source-digest "\$PREPARED_SHA"/,
    verifyStep,
  );
  requirePattern(
    "candidate file set must be exact and regular before promotion",
    /unexpected candidate asset set[\s\S]*?stat\.isFile\(\)[\s\S]*?stat\.isSymbolicLink\(\)[\s\S]*?stat\.size === 0/,
    verifyStep,
  );
  const attestation = verifyStep.indexOf('gh attestation verify "$file"');
  const checksum = verifyStep.indexOf("shasum -a 256 -c SHA256SUMS");
  if (!(attestation >= 0 && attestation < checksum)) {
    findings.push(
      "release.yml: provenance must be verified before candidate SHA256SUMS is trusted",
    );
  }
  requirePattern(
    "candidate ZIP app must verify signature, version, and exact daemon build SHA",
    /ditto -x -k "\$candidate_zip"[\s\S]*?codesign --verify --strict[\s\S]*?PlistBuddy[\s\S]*?test "\$app_version" = "\$VERSION"[\s\S]*?claudexord\.bundle\.cjs" --probe[\s\S]*?probe\.version !== process\.argv\[2\][\s\S]*?probe\.buildSha !== process\.argv\[3\]/,
    verifyStep,
  );
  requirePattern(
    "candidate app must pass packaged belt smoke",
    /promoted_belt_home="\$RUNNER_TEMP\/promoted-belt-home"[\s\S]*?HOME="\$promoted_belt_home" node scripts\/smoke-delegation-belt-entry\.mjs[\s\S]*?--entry "\$promoted_app\/Claudexor\.app\/Contents\/Resources\/claudexord\.bundle\.cjs"[\s\S]*?--config-root "\$promoted_belt_home\/config"/,
    verifyStep,
  );
  requirePattern(
    "candidate SBOM must be regenerated from the promoted app and compared",
    /generate-release-sbom\.mjs[\s\S]*?--app-bundle "\$promoted_app\/Claudexor\.app"[\s\S]*?cmp "\$candidate_sbom" "\$RUNNER_TEMP\/promoted-candidate\.spdx\.json"/,
    verifyStep,
  );
  requirePattern(
    "publish assembly must copy and compare exact candidate DMG, ZIP, and SBOM",
    /if \[ "\$RELEASE_MODE_INPUT" = publish \]; then[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.dmg" "\$assets\/"[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.zip" "\$assets\/"[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.spdx\.json" "\$assets\/"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.dmg" "\$assets\/Claudexor-\$VERSION\.dmg"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.zip" "\$assets\/Claudexor-\$VERSION\.zip"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.spdx\.json" "\$assets\/Claudexor-\$VERSION\.spdx\.json"/,
    assembleStep,
  );
  requirePattern(
    "candidate SBOM must bind both license input and document namespace to the prepared SHA",
    /else[\s\S]*?GITHUB_SHA="\$PREPARED_SHA" pnpm licenses list --prod --json \|[\s\S]*?GITHUB_SHA="\$PREPARED_SHA" node scripts\/generate-release-sbom\.mjs[\s\S]*?--app-bundle apps\/macos\/dist\/Claudexor\.app/,
    assembleStep,
  );
  const publishArmStart = assembleStep.indexOf('if [ "$RELEASE_MODE_INPUT" = publish ]; then');
  const publishArmEnd = assembleStep.indexOf("\n          else", publishArmStart);
  const publishArm =
    publishArmStart >= 0 && publishArmEnd > publishArmStart
      ? assembleStep.slice(publishArmStart, publishArmEnd)
      : "";
  if (/apps\/macos\/dist\//.test(publishArm)) {
    findings.push("release.yml: publish app assembly must not read fresh app build outputs");
  }
  const download = job.indexOf("Promote the exact candidate release artifact");
  const verify = job.indexOf("Verify promoted candidate app artifacts");
  const assemble = job.indexOf("Assemble checksums, SBOM and review evidence");
  if (!(download >= 0 && download < verify && verify < assemble)) {
    findings.push("release.yml: candidate download, verification, and assembly order is invalid");
  }
  return findings;
}

function stepBody(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  if (start < 0) return "";
  const rest = job.slice(start + marker.length);
  const next = rest.search(/^      - name: /m);
  return next < 0 ? job.slice(start) : job.slice(start, start + marker.length + next);
}

function replaceLastOccurrence(text, needle, replacement) {
  const index = text.lastIndexOf(needle);
  return index < 0
    ? text
    : `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}
