/**
 * Credential surfaces: the managed secret store and INV-135 credential
 * profiles. Thin clients — the daemon owns storage and doctor probes; the
 * profile login spawns the SAME vendor command the setup jobs run, in this
 * interactive terminal, scoped to the profile's config dir.
 */
import { spawnSync } from "node:child_process";
import { registerConfigDirProfile } from "./profile-registration.js";
import {
  ControlCredentialProfileDeleteResponse,
  ControlCredentialProfileUpdateResponse,
  ControlCredentialProfilesResponse,
  ControlSecretListResponse,
  ControlSecretMutationResponse,
  ControlSecretSetRequest,
  ControlSetupJob,
} from "@claudexor/schema";
import { streamDurableCodexLogin, terminalLoginFallback } from "./setup-login-inline.js";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import {
  CONFIG_DIR_LOGIN_HARNESSES,
  canonicalProfileLoginDir,
  configDirLoginHarnessList,
  isConfigDirLoginHarness,
} from "./config-dir-login-harnesses.js";
import { type ParsedArgs, flagStr } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonGet } from "./ops-commands.js";
import { nativeLoginEnv, nativeLoginSpec } from "./native-login.js";

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Thin client over the daemon's credential-profile listing (INV-135): the
 * durable registry lives in the global config; readiness is the daemon
 * doctor's projection — this command never probes vendors itself.
 */
export async function profilesCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  if (sub === "login") {
    // INV-135 profile login: the SAME vendor login command the setup jobs run,
    // spawned interactively in THIS terminal with the profile's scoped config
    // dir. The default vendor store is never touched; the doctor probe after
    // exit is the verification truth.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, "usage: claudexor profiles login <harness> <profile-id>");
    }
    // Claude profile login is deliberately the vendor's interactive TTY flow.
    // Inheriting its stdout while also promising one JSON object would corrupt
    // the machine surface, so refuse before discovery, prose, or spawn. Codex
    // keeps its daemon-owned device-code JSON flow below.
    if (json && harness !== "codex") {
      return printUsageError(
        true,
        `claudexor profiles login ${harness} is interactive and does not support --json`,
      );
    }
    const listing = ControlCredentialProfilesResponse.parse(
      await daemonGet("/credential-profiles"),
    );
    const entry = listing.profiles.find(
      (p) => p.profile.harness_id === harness && p.profile.profile_id === profileId,
    );
    if (!entry) {
      return printUsageError(
        json,
        `no credential profile "${profileId}" for harness "${harness}" (register it in the global config's credential_profiles)`,
      );
    }
    const profile = entry.profile;
    if (!profile.enabled) return printUsageError(json, `profile "${profileId}" is disabled`);
    if (profile.credential_kind !== "config_dir_login") {
      return printUsageError(
        json,
        `profile "${profileId}" is ${profile.credential_kind}; only config_dir_login profiles have a login flow (store its secret instead)`,
      );
    }
    // Only harnesses with a RELOCATABLE native login may profile-login.
    if (!isConfigDirLoginHarness(harness)) {
      return printUsageError(
        json,
        `harness "${harness}" has no isolated config-dir login; only ${configDirLoginHarnessList()} profiles can log in here`,
      );
    }
    // D-17: codex profile login rides the SAME durable setup job as the default
    // store (no more spawnSync bypass) — the device-code flow with inline code
    // display, scoped to the profile's CODEX_HOME. The daemon owns the flow and
    // its doctor-probe verification (INV-135).
    if (harness === "codex") {
      const { addr } = await ensureDaemon();
      const response = await controlApiFetch(addr, "/setup/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          harness,
          action: "login",
          authRequest: "subscription",
          profileId,
        }),
      });
      if (!response.ok) {
        return printUsageError(
          json,
          `could not start codex profile login (${response.status}): ${await response.text()}`,
        );
      }
      const job = ControlSetupJob.parse(await response.json());
      const accepted = !["failed", "cancelled", "timed_out", "not_supported"].includes(job.state);
      // D-17 audit point 8: follow the durable device-code job to its outcome
      // and, on the typed device_auth_unsupported miss, OFFER the legacy
      // Terminal fallback SCOPED to this profile (a y/N prompt on a TTY, a typed
      // `nextAction` in `--json`) — the same one-action fork as the default store.
      if (accepted) {
        if (!json) print(`codex/${profileId} login is managed by claudexord as ${job.jobId}.`);
        return streamDurableCodexLogin(addr, job.jobId, {
          label: `codex/${profileId}`,
          json,
          fallback: { harness: "codex" },
        });
      }
      if (json) {
        const nextAction = terminalLoginFallback(job);
        printJson({ ok: false, job, ...(nextAction ? { nextAction } : {}) });
        return 1;
      }
      print(`codex/${profileId} login was not started: ${job.message}`);
      return 1;
    }
    const spec = nativeLoginSpec(harness);
    if (!spec) {
      return printUsageError(json, `no native login command for harness "${harness}"`);
    }
    const configDir = canonicalProfileLoginDir(harness, profile.isolation_locator ?? "");
    print(`running ${spec.displayCommand} into ${configDir}`);
    const child = spawnSync(spec.binary, spec.args, {
      stdio: "inherit",
      env: nativeLoginEnv(harness, process.env, configDir),
    });
    if (child.status !== 0) {
      print(`login command exited with ${child.status ?? child.signal ?? "unknown"}`);
    }
    const after = ControlCredentialProfilesResponse.parse(
      await daemonGet("/credential-profiles"),
    ).profiles.find((p) => p.profile.harness_id === harness && p.profile.profile_id === profileId);
    const status = after?.status;
    if (json) printJson({ profile: after?.profile ?? profile, status: status ?? null });
    else
      print(
        `${harness}/${profileId}: ${status?.availability ?? "unknown"}${status?.detail ? ` — ${status.detail}` : ""}`,
      );
    return status?.verification === "passed" ? 0 : 1;
  }
  if (sub === "add") {
    // ONE registration owner shared with POST /v2/credential-profiles
    // (profile-registration.ts): locked global-config write, duplicate ids
    // refused loudly, login dir created under the confinement root.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(
        json,
        `usage: claudexor profiles add <${CONFIG_DIR_LOGIN_HARNESSES.join("|")}> <profile-id> [--display-name NAME]`,
      );
    }
    try {
      const { profile, configPath } = registerConfigDirProfile({
        harnessId: harness,
        profileId,
        displayName: flagStr(args, "display-name"),
      });
      if (json)
        printJson({
          registered: { harness, profileId, locator: profile.isolation_locator },
          config: configPath,
        });
      else {
        print(`registered ${harness}/${profileId} (login dir ${profile.isolation_locator})`);
        print(`next: claudexor profiles login ${harness} ${profileId}`);
      }
      return 0;
    } catch (err) {
      return printUsageError(json, err instanceof Error ? err.message : String(err));
    }
  }
  if (sub === "enable" || sub === "disable") {
    // The Enabled toggle of the accounts symmetry (INV-135): PATCH the
    // profile's durable `enabled` via the daemon (one locked write).
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, `usage: claudexor profiles ${sub} <harness> <profile-id>`);
    }
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(
      addr,
      `/credential-profiles/${encodeURIComponent(harness)}/${encodeURIComponent(profileId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${addr.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: sub === "enable" }),
      },
    );
    if (!response.ok) {
      return printUsageError(
        json,
        `profile ${sub} failed (${response.status}): ${await response.text()}`,
      );
    }
    const receipt = ControlCredentialProfileUpdateResponse.parse(await response.json());
    if (json) printJson(receipt);
    else
      print(
        `${sub}d ${harness}/${profileId} (${receipt.profile.enabled ? "enabled" : "disabled"})`,
      );
    return 0;
  }
  if (sub === "remove" || sub === "rm") {
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, "usage: claudexor profiles remove <harness> <profile-id>");
    }
    // Daemon-owned removal (one mutation path): registry entry + the profile's
    // own credential material (scoped login dir / namespaced secret); refuses
    // while a login job for the account is active.
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(
      addr,
      `/credential-profiles/${encodeURIComponent(harness)}/${encodeURIComponent(profileId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${addr.token}` } },
    );
    if (!response.ok) {
      return printUsageError(
        json,
        `profile removal failed (${response.status}): ${await response.text()}`,
      );
    }
    const receipt = ControlCredentialProfileDeleteResponse.parse(await response.json());
    if (json) printJson(receipt);
    else {
      print(`removed ${harness}/${profileId} (${receipt.credentialCleanup})`);
      if (receipt.cleanupWarning) print(`warning: ${receipt.cleanupWarning}`);
    }
    return 0;
  }
  if (sub !== "list") {
    return printUsageError(
      json,
      "usage: claudexor profiles [list | add <harness> <profile-id> | login <harness> <profile-id> | enable <harness> <profile-id> | disable <harness> <profile-id> | remove <harness> <profile-id>]",
    );
  }
  const result = ControlCredentialProfilesResponse.parse(await daemonGet("/credential-profiles"));
  if (json) {
    printJson(result);
    return 0;
  }
  // Unified account model (INV-135): every account is a named registry row
  // with an Enabled toggle (the only routing control); routing facts come from
  // the server-owned accountPools projection. This surface never re-derives
  // pool truth, and there is no separate native/CLI-login pseudo-row.
  const byHarness = new Map<string, Array<(typeof result.profiles)[number]>>();
  for (const entry of result.profiles) {
    const list = byHarness.get(entry.profile.harness_id) ?? [];
    list.push(entry);
    byHarness.set(entry.profile.harness_id, list);
  }
  const harnessIds = [
    ...new Set([...result.accountPools.map((pool) => pool.harness_id), ...byHarness.keys()]),
  ].sort();
  if (harnessIds.length === 0) {
    print("no accounts (connect one with `claudexor auth login <harness>`)");
    return 0;
  }
  for (const harnessId of harnessIds) {
    print(`${harnessId}:`);
    const rows = byHarness.get(harnessId) ?? [];
    if (rows.length === 0) print("  (no accounts)");
    for (const { profile, status } of rows) {
      const state = profile.enabled ? status.availability : "disabled";
      print(
        `  ${profile.profile_id} [${profile.credential_kind}] ${state}${status.detail ? ` — ${status.detail}` : ""}`,
      );
    }
    // Informational: who an UNPINNED run routes to next (never a user setting).
    const nextUp = result.accountPools.find((pool) => pool.harness_id === harnessId)?.next_up;
    if (nextUp?.kind === "profile") print(`  next up: ${nextUp.profileId}`);
    else if (nextUp?.kind === "api_key_route") print(`  next up: API key (paid route)`);
    else if (nextUp?.kind === "none") print(`  next up: nothing routable (${nextUp.reason})`);
  }
  return 0;
}

export async function secretsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  if (sub === "list") {
    const result = ControlSecretListResponse.parse(await daemonGet("/secrets"));
    if (json) printJson(result);
    else {
      if (result.secrets.length === 0) print(`no stored secrets (${result.backend})`);
      for (const secret of result.secrets) print(`${secret.name} [${secret.backend}]`);
    }
    return 0;
  }
  if (sub === "set") {
    const name = args._[2];
    if (!name) {
      return printUsageError(
        json,
        "usage: claudexor secrets set <name> --from-env <ENV_VAR>  # or pipe value on stdin",
      );
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(
        json,
        `secret name must be a managed name (${MANAGED_SECRET_NAMES.join(", ")}) or a managed base:profile slot (e.g. claude_oauth:work — profiles REQUIRE the namespaced form)`,
      );
    }
    const envVar = flagStr(args, "from-env");
    const value = envVar ? process.env[envVar] : process.stdin.isTTY ? "" : await stdinText();
    if (!value) {
      return printUsageError(
        json,
        "secret value required via --from-env or stdin; values are not accepted as positional args",
      );
    }
    const body = ControlSecretSetRequest.parse({ name, value });
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, "/secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`secret write failed (${response.status}): ${await response.text()}`);
    const receipt = ControlSecretMutationResponse.parse(await response.json());
    if (json) printJson(receipt);
    else {
      print(`stored ${name} in ${receipt.backend}`);
      if (receipt.warning) print(`warning: ${receipt.warning}`);
    }
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    const name = args._[2];
    if (!name) {
      return printUsageError(json, "usage: claudexor secrets delete <name>");
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(
        json,
        `secret name must be a managed name (${MANAGED_SECRET_NAMES.join(", ")}) or a managed base:profile slot (e.g. claude_oauth:work — profiles REQUIRE the namespaced form)`,
      );
    }
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    if (!response.ok)
      throw new Error(`secret delete failed (${response.status}): ${await response.text()}`);
    const receipt = ControlSecretMutationResponse.parse(await response.json());
    if (json) printJson(receipt);
    else print(`deleted ${name}`);
    return 0;
  }
  return printUsageError(json, "usage: claudexor secrets list|set|delete");
}
