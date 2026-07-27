import ClaudexorKit

/// One artifact tagged with the run that produced it, so an aggregate gallery
/// still fetches each file from the correct run.
struct RunArtifact: Identifiable, Equatable, Sendable {
    let runId: String
    let art: ArtifactInfo
    var id: String { "\(runId)|\(art.path)" }
}

extension ArtifactGalleryView {
    /// Preserve a shown snapshot on transient empty refreshes and disclose
    /// partial failures instead of presenting them as an empty gallery.
    static func loadDecision(
        combinedIsEmpty: Bool,
        failed: [String],
        existingNonEmpty: Bool
    ) -> GalleryLoadDecision {
        if combinedIsEmpty && !failed.isEmpty && !existingNonEmpty { return .fail }
        if combinedIsEmpty && existingNonEmpty { return .keepStale(failed: failed) }
        return .commit(failed: failed)
    }

    static func aggregate(
        runIds: [String],
        byRun: [String: [ArtifactInfo]?]
    ) -> (combined: [RunArtifact], failed: [String]) {
        var combined: [RunArtifact] = []
        var seen = Set<String>()
        var failed: [String] = []
        for runId in runIds {
            guard let list = byRun[runId] ?? nil else {
                failed.append(runId)
                continue
            }
            for artifact in list where seen.insert("\(runId)|\(artifact.path)").inserted {
                combined.append(RunArtifact(runId: runId, art: artifact))
            }
        }
        return (combined, failed)
    }

    /// Fan listing calls out concurrently without capturing MainActor state.
    nonisolated static func fetchListings(
        runIds: [String],
        produced: Bool,
        client: GatewayClient?
    ) async -> [String: [ArtifactInfo]?] {
        guard let client else { return [:] }
        return await withTaskGroup(of: (String, [ArtifactInfo]?).self) { group in
            for runId in runIds {
                group.addTask {
                    let list = produced
                        ? try? await client.listProducedFiles(runId: runId)
                        : try? await client.listRunArtifacts(runId: runId)
                    return (runId, list)
                }
            }
            var output: [String: [ArtifactInfo]?] = [:]
            for await (runId, list) in group {
                output[runId] = list
            }
            return output
        }
    }
}
