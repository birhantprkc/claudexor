import ClaudexorKit
import Foundation

extension AppModel {
    func startRemoteGlobalStream(_ locationID: ExecutionLocationID) {
        guard let requestClient = remoteClients[locationID] else { return }
        remoteGlobalStreamTasks[locationID]?.cancel()
        let token = UUID()
        remoteGlobalStreamTokens[locationID] = token
        remoteGlobalStreamTasks[locationID] = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self,
                      self.isCurrentGateway(requestClient, at: locationID),
                      self.remoteGlobalStreamTokens[locationID] == token
                else { break }
                do {
                    for try await event in requestClient.globalEvents(
                        lastEventId: self.remoteGlobalEventCursors[locationID])
                    {
                        guard self.isCurrentGateway(requestClient, at: locationID),
                              self.remoteGlobalStreamTokens[locationID] == token
                        else { return }
                        self.remoteGlobalEventCursors[locationID] = event.cursor
                        await self.handleRemoteGlobalEvent(
                            event,
                            locationID: locationID,
                            requestClient: requestClient,
                            streamToken: token)
                    }
                } catch let GatewayError.http(status, _)
                    where status == 400 || status == 409 || status == 410
                {
                    self.noteAccountsQuotaStreamFailure(
                        at: locationID,
                        reason: "Quota update cursor expired; showing last-known data.",
                        invalidateNextUp: false)
                    guard self.isCurrentGateway(requestClient, at: locationID),
                          self.remoteGlobalStreamTokens[locationID] == token
                    else { break }
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch is DecodingError {
                    self.noteAccountsQuotaStreamFailure(
                        at: locationID,
                        reason: "Quota updates could not be decoded; showing last-known data.",
                        invalidateNextUp: false)
                    guard self.isCurrentGateway(requestClient, at: locationID),
                          self.remoteGlobalStreamTokens[locationID] == token
                    else { break }
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch GatewayError.decoding {
                    self.noteAccountsQuotaStreamFailure(
                        at: locationID,
                        reason: "Quota updates could not be decoded; showing last-known data.",
                        invalidateNextUp: false)
                    guard self.isCurrentGateway(requestClient, at: locationID),
                          self.remoteGlobalStreamTokens[locationID] == token
                    else { break }
                    self.remoteGlobalEventCursors[locationID] = nil
                    await self.refreshRemoteThreads(locationID)
                } catch {
                    if Task.isCancelled { break }
                    self.noteAccountsQuotaStreamFailure(
                        at: locationID,
                        reason: "Quota update stream was interrupted; showing last-known data.",
                        invalidateNextUp: false)
                }
                guard !Task.isCancelled,
                      self.isCurrentGateway(requestClient, at: locationID),
                      self.remoteGlobalStreamTokens[locationID] == token
                else { break }
                try? await Task.sleep(for: .seconds(3))
            }
            guard let self, self.remoteGlobalStreamTokens[locationID] == token else { return }
            self.remoteGlobalStreamTokens.removeValue(forKey: locationID)
            self.remoteGlobalStreamTasks.removeValue(forKey: locationID)
        }
    }

    func streamRemoteRun(
        locationID: ExecutionLocationID,
        runID: String,
        threadID: String
    ) {
        let key = "\(locationID.rawValue)|\(runID)"
        guard remoteRunStreamTasks[key] == nil,
              let requestClient = remoteClients[locationID]
        else { return }
        let token = UUID()
        remoteRunStreamTokens[key] = token
        remoteRunStreamTasks[key] = Task { @MainActor [weak self] in
            var lastEventID: Int?
            var lastDetailRefresh = Date.distantPast
            var attempt = 0
            while !Task.isCancelled {
                do {
                    for try await envelope in requestClient.events(
                        runId: runID, lastEventId: lastEventID)
                    {
                        guard let self,
                              self.isCurrentGateway(requestClient, at: locationID),
                              self.remoteRunStreamTokens[key] == token
                        else { return }
                        if envelope.seq > 0 { lastEventID = envelope.seq }
                        attempt = 0
                        if self.selectedExecutionLocation == locationID,
                           self.selectedThreadId == threadID,
                           Date().timeIntervalSince(lastDetailRefresh) >= 0.25
                        {
                            lastDetailRefresh = .now
                            await self.refreshOpenThread(
                                locationID: locationID, id: threadID,
                                mayReconnect: false)
                        }
                    }
                    break
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    if attempt > 5 { break }
                    try? await Task.sleep(for: .seconds(min(Double(attempt) * 2, 10)))
                }
            }
            guard let self,
                  self.isCurrentGateway(requestClient, at: locationID),
                  self.remoteRunStreamTokens[key] == token
            else { return }
            await self.refreshRemoteThreads(locationID)
            guard self.isCurrentGateway(requestClient, at: locationID),
                  self.remoteRunStreamTokens[key] == token
            else { return }
            if self.selectedExecutionLocation == locationID,
               self.selectedThreadId == threadID
            {
                await self.refreshOpenThread(
                    locationID: locationID, id: threadID, mayReconnect: false)
            }
            guard self.remoteRunStreamTokens[key] == token else { return }
            self.remoteRunStreamTokens.removeValue(forKey: key)
            self.remoteRunStreamTasks.removeValue(forKey: key)
        }
    }

    private func handleRemoteGlobalEvent(
        _ event: JournalEvent,
        locationID: ExecutionLocationID,
        requestClient: GatewayClient,
        streamToken: UUID
    ) async {
        if event.type == Self.quotaProjectionMarker {
            noteQuotaProjectionMarker(
                at: locationID, invalidateNextUp: false, cursor: event.cursor)
            return
        }
        guard event.type == "thread.head.updated" else { return }
        await refreshRemoteThreads(locationID)
        guard isCurrentGateway(requestClient, at: locationID),
              remoteGlobalStreamTokens[locationID] == streamToken,
              selectedExecutionLocation == locationID,
              let selectedThreadId,
              event.payload["thread_id"]?.stringValue == selectedThreadId
        else { return }
        await refreshOpenThread(
            locationID: locationID, id: selectedThreadId, mayReconnect: false)
    }

    func cancelRemoteStreams(_ locationID: ExecutionLocationID) {
        suspendAccountsQuotaObserver(at: locationID, discardCursor: true)
        retireAccountsRequests(at: locationID)
        retireAccountsQuotaDisplayRequest(at: locationID, discardProjection: false)
        remoteGlobalStreamTokens.removeValue(forKey: locationID)
        remoteGlobalStreamTasks.removeValue(forKey: locationID)?.cancel()
        remoteGlobalEventCursors.removeValue(forKey: locationID)
        let prefix = "\(locationID.rawValue)|"
        for key in Array(remoteRunStreamTasks.keys) where key.hasPrefix(prefix) {
            remoteRunStreamTokens.removeValue(forKey: key)
            remoteRunStreamTasks.removeValue(forKey: key)?.cancel()
        }
    }
}
