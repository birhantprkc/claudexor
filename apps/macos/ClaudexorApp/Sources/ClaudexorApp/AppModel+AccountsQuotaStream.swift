import ClaudexorKit
import Foundation

// MARK: - Accounts snapshot → quota-event handoff

extension AppModel {
    /// Retire only the observer. Keeping its cursor lets a failed foreground
    /// refresh resume observation without claiming the stale projection is fresh.
    @discardableResult
    func suspendAccountsQuotaObserver(
        at locationID: ExecutionLocationID,
        discardCursor: Bool = false
    ) -> String? {
        accountsQuotaStreamTokens.removeValue(forKey: locationID)
        accountsQuotaStreamTasks.removeValue(forKey: locationID)?.cancel()
        let cursor = accountsQuotaEventCursors[locationID]
        if discardCursor { accountsQuotaEventCursors.removeValue(forKey: locationID) }
        return cursor
    }

    /// Observe one complete Accounts snapshot from its server-authored cursor.
    /// This cursor is the sole owner of quota-derived `next_up` invalidation.
    /// Display recovery is delegated to the subscriber-scoped cheap GET owner.
    func startAccountsQuotaObserver(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        after cursor: String
    ) {
        accountsQuotaStreamTokens.removeValue(forKey: locationID)
        accountsQuotaStreamTasks.removeValue(forKey: locationID)?.cancel()
        let token = UUID()
        accountsQuotaStreamTokens[locationID] = token
        accountsQuotaEventCursors[locationID] = cursor
        accountsQuotaStreamTasks[locationID] = Task { @MainActor [weak self] in
            await self?.runAccountsQuotaObserver(
                at: locationID, client: requestClient, token: token)
        }
    }

    private func accountsQuotaObserverIsCurrent(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        token: UUID
    ) -> Bool {
        !Task.isCancelled
            && isCurrentGateway(requestClient, at: locationID)
            && accountsQuotaStreamTokens[locationID] == token
    }

    private func runAccountsQuotaObserver(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        token: UUID
    ) async {
        do {
            for try await event in requestClient.globalEvents(
                lastEventId: accountsQuotaEventCursors[locationID])
            {
                guard accountsQuotaObserverIsCurrent(
                    at: locationID, client: requestClient, token: token)
                else { return }
                accountsQuotaEventCursors[locationID] = event.cursor
                if event.type == Self.quotaProjectionMarker {
                    noteQuotaProjectionMarker(
                        at: locationID,
                        invalidateNextUp: true,
                        cursor: event.cursor)
                }
            }
            if accountsQuotaObserverIsCurrent(
                at: locationID, client: requestClient, token: token)
            {
                noteAccountsQuotaStreamFailure(
                    at: locationID,
                    reason: "Quota update stream ended; showing last-known data.",
                    invalidateNextUp: true)
            }
        } catch {
            if accountsQuotaObserverIsCurrent(
                at: locationID, client: requestClient, token: token)
            {
                noteAccountsQuotaStreamFailure(
                    at: locationID,
                    reason: "Quota update stream was interrupted; showing last-known data.",
                    invalidateNextUp: true)
            }
        }

        guard accountsQuotaStreamTokens[locationID] == token else { return }
        accountsQuotaStreamTokens.removeValue(forKey: locationID)
        accountsQuotaStreamTasks.removeValue(forKey: locationID)
    }
}
