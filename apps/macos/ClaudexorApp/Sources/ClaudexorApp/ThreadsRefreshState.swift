import Foundation

/// Durable sidebar-list invalidation (sol review #3): `dirty` holds from "a
/// ping invalidated the list" until a refetch SUCCEEDS — the global cursor
/// consumed the ping, so nothing else would replay it. `delay` is the next
/// attempt's pacing: the coalescing window while healthy, doubling per failure
/// (capped) while the daemon is unreachable — a heartbeat, never a hot loop.
struct ThreadsRefreshState {
    /// Coalescing window while healthy; the backoff cap bounds the retry
    /// heartbeat while the daemon is unreachable (one cheap GET per beat).
    static let coalesce: TimeInterval = 0.2
    static let maxBackoff: TimeInterval = 5.0
    var dirty = false
    var delay: TimeInterval = Self.coalesce
}
