import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { DurableJournal } from "@claudexor/journal";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";

/** One cancelable maintenance flight under the daemon's existing root writer.
 * A manager creates a new journal object per generation and closes the old one;
 * those exact objects are the dedupe keys, never another durable authority. */
export class JournalMaintenance {
  private readonly pending = new Set<DurableJournal>();
  private readonly attempted = new WeakSet<DurableJournal>();
  private readonly controller = new AbortController();
  private flight: Promise<void> | null = null;
  private armed = false;
  private stopped = false;
  private cleaned = false;
  private readonly stagingDir: string;

  constructor(
    rootDir: string,
    private readonly warn: (message: string) => void,
  ) {
    this.stagingDir = join(rootDir, "journal-compaction");
  }

  request = (journal: DurableJournal): void => {
    if (this.stopped || this.attempted.has(journal)) return;
    this.pending.add(journal);
    this.startFlight();
  };

  /** Called only after normal admission, including recovery-route reopen. */
  arm(): void {
    if (this.armed || this.stopped) return;
    try {
      // A sibling of journal/, so candidate churn never changes a concurrently
      // prepared partition's journal-root directory fingerprint.
      ensureCanonicalPrivateDirectory(this.stagingDir);
      this.armed = true;
      this.startFlight();
    } catch (error) {
      this.warnFailure(error);
    }
  }

  /** Synchronous prefix revokes new work and aborts bulk I/O. The existing
   * daemon stop wrapper awaits cleanup before journals/root authority close. */
  stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    this.controller.abort();
    return this.flight ?? Promise.resolve();
  }

  private startFlight(): void {
    if (!this.armed || this.stopped || this.flight) return;
    const flight = this.run()
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) this.warnFailure(error);
      })
      .finally(() => {
        if (this.flight === flight) this.flight = null;
        if (this.pending.size > 0) this.startFlight();
      });
    this.flight = flight;
  }

  private async run(): Promise<void> {
    await setImmediate(undefined, { signal: this.controller.signal });
    if (!this.cleaned) {
      this.cleaned = true;
      await this.removeCrashCandidates();
    }
    while (!this.stopped && this.pending.size > 0) {
      const journal = this.pending.values().next().value!;
      this.pending.delete(journal);
      this.attempted.add(journal);
      try {
        if (journal.state().status !== "ready") continue;
      } catch {
        continue;
      } // the manager retired this exact generation
      try {
        await journal.compactInBackground({
          stagingDir: this.stagingDir,
          signal: this.controller.signal,
        });
      } catch (error) {
        this.warnFailure(error);
      }
    }
  }

  private async removeCrashCandidates(): Promise<void> {
    for (const name of await readdir(this.stagingDir)) {
      this.controller.signal.throwIfAborted();
      // Only this producer's UUID-shaped scratch files, never journal.bin,
      // append.pending, recovery receipts, archives or unrelated entries.
      if (!/^journal-compaction-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.compact$/.test(name))
        continue;
      const path = join(this.stagingDir, name);
      const stat = await lstat(path);
      if (stat.isFile() && stat.nlink === 1) await unlink(path);
    }
  }

  private warnFailure(error: unknown): void {
    this.warn(
      `journal maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
