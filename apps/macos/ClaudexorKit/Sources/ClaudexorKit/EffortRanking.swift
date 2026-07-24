import Foundation

/// Canonical cross-harness reasoning-effort RANK order, weakest → strongest.
///
/// Mirrors `EFFORT_RANK_ORDER` in the TypeScript schema SSOT and is held to it by
/// the derived wire fixture `effort-rank-order.json` (INV-138): change the TS
/// table and the Swift test fails until this list follows, so a level added
/// upstream can never sort into the wrong place here.
///
/// This is a RANKING table, not an allow-list. A harness advertises its own
/// vocabulary per model, and a level this table has never heard of is still
/// offered — it simply sorts after the ranked ones instead of being dropped.
public enum EffortRanking {
    public static let order: [String] = [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
    ]

    /// Advertised levels sorted weakest → strongest: ranked levels in rank order,
    /// then anything the vendor advertises that this table does not rank.
    public static func sorted(_ advertised: some Sequence<String>) -> [String] {
        let declared = Set(advertised)
        let ranked = order.filter { declared.contains($0) }
        return ranked + declared.subtracting(ranked).sorted()
    }
}
