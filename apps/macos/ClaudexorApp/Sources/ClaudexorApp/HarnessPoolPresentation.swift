import Foundation

// MARK: - Harness pool: explicit Auto vs. subset (owner F9)
//
// The eligible harness pool has two readable modes. The wire is UNCHANGED:
//   - Auto  → an EMPTY sticky pool → the engine auto-pools every available
//             harness. This is what the composer already sends for "no explicit
//             pool" (`eligibleHarnesses` omitted / nil).
//   - Subset → a NON-EMPTY pool → exactly those harnesses ride.
//
// The old UI rendered every chip unselected in Auto, so "absence means auto" was
// invisible ("почему они все выключены по дефолту?"). This maps the same two wire
// states onto a readable UI: a leading Auto chip that is SELECTED by default, and
// the available harness chips highlighted-as-included. Pure + unit-tested so the
// mode mapping can't drift from what the composer puts on the wire.
enum HarnessPoolPresentation {
    struct Availability: Equatable {
        var available: Bool
        var reason: String
    }

    struct ChipDescriptor: Equatable {
        var included: Bool
        var help: String
        var accessibilityValue: String
    }
    /// Auto = the sticky pool is empty (engine auto-pools all available). Any
    /// non-empty pool is an explicit user subset.
    static func isAuto(pool: [String]) -> Bool { pool.isEmpty }

    /// The wire value after tapping the "Auto" chip: clear the explicit subset so
    /// the pool is empty again → the engine routes across all available. The body
    /// the composer sends is unchanged from today's "no explicit pool".
    static func selectingAuto() -> [String] { [] }

    /// The wire value after tapping a harness chip. In Auto mode the visible set
    /// IS "all available", so the first tap MATERIALIZES that set as an explicit
    /// subset with the tapped harness toggled off; in explicit mode it toggles the
    /// harness within the current subset. The result is re-ordered to follow
    /// `available` so the wire body is deterministic. Emptying the subset falls
    /// back to Auto (empty = auto, the same wire truth).
    static func toggling(_ family: String, pool: [String], available: [String]) -> [String] {
        var set = Set(isAuto(pool: pool) ? available : pool)
        if set.contains(family) { set.remove(family) } else { set.insert(family) }
        // Deterministic order: available harnesses in their canonical order, then
        // any stray ids not in `available` (defensive) in their original order.
        return available.filter { set.contains($0) } + pool.filter { !available.contains($0) && set.contains($0) }
    }

    /// Is a harness chip rendered as INCLUDED (highlighted)? In Auto mode every
    /// available harness is included; in explicit mode only the chosen subset.
    static func isIncluded(_ family: String, pool: [String], available: [String]) -> Bool {
        isAuto(pool: pool) ? available.contains(family) : pool.contains(family)
    }

    /// The families the popover PRESENTS as included — the SAME set the chips
    /// highlight, so the per-harness model rows and selection pruning can't drift
    /// from the chip highlight (QA-011). Auto (empty pool) expands to the ordered
    /// available families; an explicit subset stays exactly itself. The wire pool
    /// is never materialized — this is a presentation projection only.
    static func includedFamilies(pool: [String], available: [String]) -> [String] {
        isAuto(pool: pool) ? available : pool
    }

    /// ONE per-family presentation owner: visual selection, hover help and AX
    /// value are derived from the same membership fact.
    static func chipDescriptor(
        _ family: String,
        pool: [String],
        available: [String],
        availability: Availability
    ) -> ChipDescriptor {
        let included = isIncluded(family, pool: pool, available: available)
        if !availability.available {
            if isAuto(pool: pool) {
                return .init(
                    included: included,
                    help: "Auto includes available harnesses; this one is unavailable: \(availability.reason)",
                    accessibilityValue: "Not included by Auto, unavailable"
                )
            }
            let membership = included ? "included" : "excluded"
            let accessibilityMembership = included ? "Included" : "Excluded"
            return .init(
                included: included,
                help: "This harness is \(membership) in the explicit eligible pool, but is unavailable: \(availability.reason)",
                accessibilityValue: "\(accessibilityMembership), unavailable"
            )
        }
        if isAuto(pool: pool) {
            return .init(
                included: included,
                help: "This harness is included by Auto. Select it to pin an explicit subset.",
                accessibilityValue: "Included by Auto"
            )
        }
        return included
            ? .init(
                included: true,
                help: "This harness is included in the explicit eligible pool. Select it to exclude it.",
                accessibilityValue: "Included"
            )
            : .init(
                included: false,
                help: "This harness is excluded from the explicit eligible pool. Select it to include it.",
                accessibilityValue: "Excluded"
            )
    }

    /// The caption that states the semantics under the pool chips.
    static func caption(pool: [String]) -> String {
        isAuto(pool: pool)
            ? "Auto — routes across all available harnesses."
            : "Explicit subset — only the highlighted harnesses are eligible. Pick Auto to route across all available."
    }
}
