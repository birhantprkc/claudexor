#!/usr/bin/env node
import { join } from "node:path";
import {
  DaemonClient,
  commandProjection,
  interactionProjection,
  operatorDecisionProjection,
  runEventProjection,
  JournalManager,
  DaemonServer,
  InteractionRegistry,
  ProjectPartitions,
  projectProjection,
  RunEventBus,
  ResourceStore,
  quotaPacerFileStore,
  quotaProjection,
  threadHeadPingProjection,
  threadProjection,
  type ThreadHeadPingSink,
  daemonDir,
  defaultSocketPath,
  acquireRootAuthority,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
} from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import {
  createDaemonQuotaPoller,
  createStartupAdmissionRuntime,
  openStartupDiagnostics,
} from "./daemon-admission-runtime.js";
import { armDaemonLifecycle, logLine } from "./daemon-lifecycle.js";
import {
  bindRecoveryTransport,
  controlApiEnabledForStartup,
  DaemonStartupAdmission,
  proveRecoveryTransport,
  quarantineGhostProjectsAtStartup,
  recoveryBlockedPartitions,
} from "./daemon-startup.js";
import { engineBuildIdentity, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { scheduleStartupRetention } from "./retention-service.js";
import { controlServices } from "./control-services.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { buildGateway } from "./registry.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { bustGlobalCredentialStatusCaches } from "./credential-status-invalidation.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import { quotaRefreshers } from "./quota-refreshers.js";
import {
  dispatchClaudexordEntry,
  runIfDirectEntry,
  runProbeIfRequested,
} from "./claudexord-entry.js";
import { createDelegationDaemonBinding } from "./delegation-daemon-binding.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";
import { runStartupAccountsMigration } from "./accounts-unified-migration.js";
import { runStopIfRequested } from "./runtime-replacement-stop.js";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";
import { createModelServices } from "./model-services.js";
import { isModelOperation } from "@claudexor/schema";
const NO_PROJECT_ROOT = noProjectRepoRoot();

export async function main(): Promise<void> {
  // Probe and identity-proven stop must run before any durable startup.
  if (runProbeIfRequested(process.argv.slice(2))) return;
  if (await runStopIfRequested(process.argv.slice(2))) return;
  const servingIdentity = engineBuildIdentity();
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  // D5 stage 1: permanent barrier (epoch/floor refusals) before ANY recovery.
  const rootAuthority = acquireRootAuthority({ socketPath, version: servingIdentity.version });
  // C8: private diagnostics open right after the authority win (never control lifecycle).
  const startupDiagnostics = openStartupDiagnostics(servingIdentity);
  let shutdownRuntime: DaemonRuntimeShutdown | null = null;
  // Release wave round-12 BLOCK: the single-writer lease may only be released
  // after a CLEAN shutdown — a failed/partial shutdown keeps components that
  // can still write, and releasing would let a successor acquire ownership
  // beside them. On failure the lease dies with the process instead.
  let releaseWriterLease = true;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  let quotaPoller: ReturnType<typeof createDaemonQuotaPoller> | null = null;
  try {
    const token = ensureToken();

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }

    const bus = new RunEventBus();
    const { authority: delegationBudgetAuthority, bind: bindDelegationDaemon } =
      createDelegationDaemonBinding();
    const journalManager = new JournalManager(daemonDir());
    const commandStoreSlot = journalManager.registerProjection(commandProjection());
    const interactionStoreSlot = journalManager.registerProjection(interactionProjection());
    const operatorDecisionStoreSlot = journalManager.registerProjection(
      operatorDecisionProjection(),
    );
    const runEventStoreSlot = journalManager.registerProjection(runEventProjection());
    const projectStoreSlot = journalManager.registerProjection(projectProjection());
    const quotaStoreSlot = journalManager.registerProjection(
      quotaProjection(
        quotaRefreshers(),
        quotaSubjectUniverseFromConfig,
        undefined,
        // Daemon-private per-vendor rate-limit floors (never in the journal).
        quotaPacerFileStore(daemonDir()),
      ),
    );
    // Sidebar invalidation ping (W12): a GLOBAL-partition emitter every
    // ThreadStore (global + per-project) writes through, so any thread
    // mutation reaches the app's single global stream. The ping is auxiliary
    // invalidation — it must never fail the mutation that triggered it
    // (mirrors the runner's turn-binding policy).
    const threadHeadPingSlot = journalManager.registerProjection(threadHeadPingProjection());
    const threadHeadPing: ThreadHeadPingSink = (ping) => {
      try {
        threadHeadPingSlot.current().ping(ping);
      } catch {
        /* invalidation ping must never fail the thread mutation */
      }
    };
    const threadStoreSlot = journalManager.registerProjection(threadProjection(threadHeadPing));
    const setupStoreSlot = journalManager.registerProjection({
      name: "setup",
      create: (journal) => new SetupJobStore(daemonDir(), { journal }),
      validate: (store) => store.validateProjection(),
    });
    // D5 stage 2: read-only prepare + validate; zero recovery writes.
    const globalPreparation = journalManager.prepare();
    const admission = new DaemonStartupAdmission();
    quotaPoller = createDaemonQuotaPoller(() => {
      try {
        void quotaStoreSlot.current().pollStale();
      } catch {}
    });
    const threads = new ProjectPartitions(
      daemonDir(),
      projectStoreSlot,
      commandStoreSlot,
      interactionStoreSlot,
      operatorDecisionStoreSlot,
      runEventStoreSlot,
      threadStoreSlot,
      threadHeadPing,
    );
    const partitionsPreparation = threads.prepare();
    const startupBlockedPartitions = recoveryBlockedPartitions({
      globalPreparation,
      partitionsPreparation,
    });
    const interactions = new InteractionRegistry({
      forRequest: (params) => threads.interactionsForRequest(params),
      all: () => threads.interactionStores(),
    });
    // C5b: construction mkdirs under the daemon dir and the recovery plane
    // serves no resources — the store materializes on first product use.
    let resourceStore: ResourceStore | null = null;
    const resources = (): ResourceStore =>
      (resourceStore ??= new ResourceStore(join(daemonDir(), "resource-store")));

    const selfClient = new DaemonClient(socketPath, token);
    const models = createModelServices({
      commands: threads,
      resources,
      client: selfClient,
      quota: () => quotaStoreSlot.current(),
      warn: (message) => logLine(logPath(), message),
    });
    const agentRunner = createDaemonAgentRunner({
      delegationBudgetAuthority,
      quotaStore: () => quotaStoreSlot.current(),
      threads,
      interactions,
      resources,
      bus,
    });

    const server = new DaemonServer({
      socketPath,
      token,
      commands: threads,
      servingMode: admission.snapshot,
      delegationAuthority: delegationBudgetAuthority,
      onCommandTerminal: (record) => models.operations.onCommandTerminal(record),
      onRunTerminal: (runId, threadId) => {
        interactions.dropForRun(runId);
        // Run-terminal is the one W12 path with no thread-store mutation to
        // ride — the terminal changes the thread's presented state, so ping.
        if (threadId) threads.pingThreadHead(threadId);
      },
      onTurnEnqueueFailed: (turnId, problem) => threads.setTurnEnqueueError(turnId, problem),
      onShutdownRequested: () =>
        shutdownRuntime?.beginShutdown("socket-rpc stop") ??
        Promise.reject(new Error("daemon shutdown coordinator is not initialized")),
      onRuntimeReplacementRequested: () => {
        if (!shutdownRuntime) {
          throw Object.assign(new Error("daemon shutdown coordinator is not initialized"), {
            code: "runtime_activity_unknown",
            status: 503,
            retryable: true,
          });
        }
        return shutdownRuntime.beginRuntimeReplacement();
      },
      runtimeIdentity: { version: servingIdentity.version, buildSha: servingIdentity.sha },
      runtimeLeaseOwner: rootAuthority.lease.owner,
      runner: (params, ctx) =>
        isModelOperation(params)
          ? models.operations.execute(params, ctx)
          : agentRunner(params, ctx),
    });
    bindDelegationDaemon(server);

    const authReadiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: NO_PROJECT_ROOT,
    });
    const setupBinding = new SetupLifecycleBinding(setupStoreSlot, (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) => {
          bustGlobalCredentialStatusCaches(() => quotaStoreSlot.current());
          authReadiness.invalidate(harness);
        },
      }),
    );
    let control: DaemonControlApiServer | null = null;
    shutdownRuntime = new DaemonRuntimeShutdown({
      daemon: {
        stop: () => {
          models.close();
          return server.stop();
        },
      },
      setup: setupBinding,
      control: () => control,
      journal: {
        close: () => {
          quotaPoller?.stop();
          threads.close();
          journalManager.close();
        },
      },
      log: (message) => logLine(logPath(), message),
    });
    // The daemon owns its services whether or not the HTTP surface is up —
    // the startup retention pass below consumes them directly.
    const services = controlServices(
      interactions,
      () => projectStoreSlot.current(),
      threads,
      setupBinding,
      journalManager,
      authReadiness,
      resources,
      () => quotaStoreSlot.current(),
      () => selfClient.list(),
    );
    const runRetention = services.runRetention;
    services.runRetention = models.withRetention(runRetention);
    Object.assign(services, models.routes);
    control = !controlApiEnabledForStartup({
      disabledByEnv: process.env.CLAUDEXOR_NO_CONTROL_API === "1",
      blockedPartitions: startupBlockedPartitions,
      log: (message) => logLine(logPath(), message),
    })
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: new DaemonClient(socketPath, token),
          port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
          servingMode: admission.snapshot,
          bus,
          services,
        });
    lifecycle = armDaemonLifecycle({
      daemonDir: daemonDir(),
      logPath: logPath(),
      ...(startupDiagnostics.diagnostics ? { diagnostics: startupDiagnostics.diagnostics } : {}),
      beginShutdown: (reason) => shutdownRuntime!.beginShutdown(reason),
    });

    const { runAdmissionCompletion, wrapQuarantineWithReopen } = createStartupAdmissionRuntime({
      admission,
      grant: rootAuthority,
      global: journalManager,
      partitions: threads,
      diagnostics: startupDiagnostics,
      normalPlane: {
        requested: () => shutdownRuntime!.requested(),
        armQuotaPolling: () => quotaPoller!.arm(),
        beginPidSnapshots: () => lifecycle!.beginPidSnapshots(),
        migrateAccounts: () =>
          runStartupAccountsMigration(threads, quotaStoreSlot.current(), (m) =>
            logLine(logPath(), redactSecrets(m)),
          ),
        startSetup: () => setupBinding.start(),
        quarantineGhosts: () =>
          quarantineGhostProjectsAtStartup(threads, (message) => logLine(logPath(), message)),
        scheduleRetention: () =>
          scheduleStartupRetention(services.runRetention, {
            logPath: logPath(),
            shuttingDown: () => shutdownRuntime!.requested(),
          }),
      },
    });
    services.recoveryQuarantinePartition = wrapQuarantineWithReopen(
      services.recoveryQuarantinePartition,
    );

    // D5 stage 3: bind the REAL transport with product admission CLOSED, then
    // prove self-health/exact identity through it before anything destructive.
    const controlAddr = await bindRecoveryTransport({
      server,
      control,
      requested: () => shutdownRuntime!.requested(),
      daemonDir: daemonDir(),
      logPath: logPath(),
      socketPath,
    });
    if (!shutdownRuntime.requested()) {
      await proveRecoveryTransport({
        socket: selfClient,
        identity: servingIdentity,
        token,
        control: controlAddr,
      });
      // D5 stage 4: floor advance + destructive recovery + normal admission —
      // or stay recovery-only with the floor unchanged and cleanup off. The
      // normal-plane side effects run inside the single-flight completion.
      await runAdmissionCompletion(() => startupBlockedPartitions);
    }
    await shutdownRuntime.wait();
    lifecycle.finalize();
    logLine(logPath(), "claudexord shut down");
    startupDiagnostics.recordStage("shutdown_complete", "claudexord shut down");
  } catch (error) {
    // logLine is already best-effort; a failed diagnostic write never masks
    // the lifecycle failure itself.
    logLine(
      logPath(),
      `daemon lifecycle FAILED: ${redactSecrets(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )}`,
    );
    startupDiagnostics.recordFailure("daemon lifecycle FAILED", error);
    if (shutdownRuntime) {
      try {
        await shutdownRuntime.beginShutdown("startup failure");
        lifecycle?.finalize();
      } catch (shutdownError) {
        logLine(
          logPath(),
          `shutdown FAILED: ${redactSecrets(
            shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
          )}`,
        );
        releaseWriterLease = false;
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    quotaPoller?.stop();
    startupDiagnostics.close();
    // Drops only the live writer claim; the barrier itself persists (D1).
    if (releaseWriterLease) rootAuthority.release();
  }
}

/** Explicit entry preserves import-side-effect freedom for daemon probes. */
export function runClaudexordEntry(): void {
  dispatchClaudexordEntry(main);
}

runIfDirectEntry(import.meta.url, runClaudexordEntry);
