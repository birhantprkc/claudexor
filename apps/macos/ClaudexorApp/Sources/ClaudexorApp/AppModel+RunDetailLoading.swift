import Foundation
import ClaudexorKit

// View hydration and event-milestone refresh share one per-run request owner.
// Stored state remains on AppModel because Observation does not permit stored
// extension properties.
extension AppModel {
    /// View-only hydration: one successful snapshot per run until reconnect.
    /// Unlike milestone `loadRunDetail`, overlapping callers do not request a
    /// trailing second snapshot.
    func ensureRunDetail(_ id: String, insertingIfMissing: Bool = false) async {
        if hydratedRunDetails.contains(id) { return }
        if let inFlight = runDetailLoads[id] {
            await inFlight.value
            return
        }
        await loadRunDetail(id, insertingIfMissing: insertingIfMissing)
    }

    /// Milestone refreshes coalesce concurrent triggers into one lead plus at
    /// most one trailing snapshot. A UUID token prevents an old connection's
    /// completion from clearing a new same-run request after reconnect.
    func loadRunDetail(_ id: String, insertingIfMissing: Bool = false) async {
        if let inFlight = runDetailLoads[id] {
            if runDetailAcceptingTrailing.contains(id) { runDetailTrailing.insert(id) }
            await inFlight.value
            return
        }
        runDetailAcceptingTrailing.insert(id)
        let loadToken = UUID()
        let load = Task { @MainActor [weak self] in
            guard let self else { return }
            self.runDetailTrailing.remove(id)
            await self.performRunDetailLoad(
                id, insertingIfMissing: insertingIfMissing,
                loadToken: loadToken)
            guard self.runDetailLoadTokens[id] == loadToken else { return }
            self.runDetailAcceptingTrailing.remove(id)
            if self.runDetailTrailing.remove(id) != nil {
                await self.performRunDetailLoad(
                    id, insertingIfMissing: insertingIfMissing,
                    loadToken: loadToken)
            }
            if self.runDetailLoadTokens[id] == loadToken {
                self.runDetailLoads[id] = nil
                self.runDetailLoadTokens[id] = nil
            }
        }
        runDetailLoadTokens[id] = loadToken
        runDetailLoads[id] = load
        await load.value
    }

    func selectedThreadAuthorizesColdRun(_ runId: String) -> Bool {
        guard selectedThreadDetail?.thread.id == selectedThreadId else { return false }
        return selectedThreadDetail?.turns.contains {
            $0.runId == runId || ($0.run?.delegatedChildRunIds ?? []).contains(runId)
        } == true
    }

    func firstArtifactText(client: GatewayClient, runId: String, paths: [String]) async -> String? {
        for path in paths {
            if let text = try? await client.artifactText(runId: runId, path: path),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let limit = 256_000
                return text.count > limit
                    ? String(text.prefix(limit))
                        + "\n\n_Inline preview bounded; open \(path) for the full artifact._"
                    : text
            }
        }
        return nil
    }
}
