/** Run work with bounded concurrency while preserving each item's source index. */
export async function runBounded<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await work(items[idx] as T, idx);
    }
  });
  // Do not let the first rejected worker release resources that its already
  // admitted siblings still use. Preserve failure semantics, but only rethrow
  // after every worker has settled.
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}
