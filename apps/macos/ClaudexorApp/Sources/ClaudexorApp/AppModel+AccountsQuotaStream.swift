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
    /// A quota marker or a lost/stale stream expires the derived quota + next_up
    /// once. The explicit Accounts refresh is the only recovery owner.
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
        var expired = false
        do {
            for try await event in requestClient.globalEvents(
                lastEventId: accountsQuotaEventCursors[locationID])
            {
                guard accountsQuotaObserverIsCurrent(
                    at: locationID, client: requestClient, token: token)
                else { return }
                accountsQuotaEventCursors[locationID] = event.cursor
                if event.type == "quota.projection.updated" {
                    expired = true
                    break
                }
            }
            // An unexpected EOF can hide a later marker just as surely as a
            // stale cursor. Stop and require one explicit refresh.
            if accountsQuotaObserverIsCurrent(
                at: locationID, client: requestClient, token: token)
            {
                expired = true
            }
        } catch {
            expired = accountsQuotaObserverIsCurrent(
                at: locationID, client: requestClient, token: token)
        }

        guard accountsQuotaStreamTokens[locationID] == token else { return }
        if expired { expireAccountsQuotaProjection(at: locationID) }
        accountsQuotaStreamTokens.removeValue(forKey: locationID)
        accountsQuotaStreamTasks.removeValue(forKey: locationID)
    }

    /// Profiles, Enabled, identity, and readiness remain valid. Only fields
    /// derived from the quota epoch lose authority.
    func expireAccountsQuotaProjection(at locationID: ExecutionLocationID) {
        accountsNextUpAuthorityFresh[locationID] = false
        if locationID == .local {
            quotaResponse = nil
        } else {
            remoteQuotaResponses.removeValue(forKey: locationID)
        }
    }
}
