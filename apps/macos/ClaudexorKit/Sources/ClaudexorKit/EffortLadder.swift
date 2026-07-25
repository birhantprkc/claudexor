import Foundation

/// Positional merge of vendor-ordered reasoning-effort ladders.
///
/// There is no static rank table anywhere in Claudexor: vendors return their
/// effort levels already ordered weakest → strongest, the manifest's
/// `effort_levels` / `model_effort_levels` arrays carry that order verbatim,
/// and this merge is how several such lists become one picker ordering.
/// Mirrors `mergeEffortLadders` in the TypeScript schema SSOT: a stable
/// topological merge over each list's own adjacency (ties break on first
/// appearance), so lists that are prefixes/subsets of one another merge into
/// the longest ladder and a brand-new vendor level lands at its advertised
/// position with no code change here.
public enum EffortLadder {
    /// Merge already-ordered advertised ladders into one, weakest → strongest.
    /// If two ladders genuinely contradict each other's relative order, falls
    /// back to first-seen order — this is a display ordering for pickers, and
    /// inventing a rank would be worse than showing the vendor's first answer.
    public static func merge(_ ladders: [[String]]) -> [String] {
        var firstSeen: [String] = []
        var successors: [String: Set<String>] = [:]
        var indegree: [String: Int] = [:]
        for ladder in ladders {
            for level in ladder where indegree[level] == nil {
                indegree[level] = 0
                successors[level] = []
                firstSeen.append(level)
            }
            for index in 1..<max(ladder.count, 1) {
                let before = ladder[index - 1]
                let after = ladder[index]
                guard before != after, successors[before]?.contains(after) == false else { continue }
                successors[before]?.insert(after)
                indegree[after, default: 0] += 1
            }
        }
        var order: [String] = []
        var emitted = Set<String>()
        while emitted.count < firstSeen.count {
            guard let next = firstSeen.first(where: { !emitted.contains($0) && indegree[$0] == 0 })
            else {
                // Contradictory vendor orders: first-seen fallback, never an invented rank.
                return order + firstSeen.filter { !emitted.contains($0) }
            }
            emitted.insert(next)
            order.append(next)
            for succ in successors[next] ?? [] { indegree[succ, default: 1] -= 1 }
        }
        return order
    }
}
