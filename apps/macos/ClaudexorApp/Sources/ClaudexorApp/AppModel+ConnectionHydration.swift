import Foundation
import ClaudexorKit

// MARK: - Connection-bound projection hydration

// These owners capture both the exact gateway and its generation before I/O.
// A manual reconnect can therefore retire a delayed success or failure without
// allowing the previous daemon to repaint the successor's projections.
extension AppModel {
    func refreshSecrets(locationID requestedLocationID: ExecutionLocationID? = nil) async {
        let locationID = requestedLocationID ?? activeExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return }
        let requestGeneration = locationID == .local
            ? connectionGeneration
            : executionLocationGeneration(for: locationID)
        let requestIsCurrent = {
            let currentGeneration = locationID == .local
                ? self.connectionGeneration
                : self.executionLocationGeneration(for: locationID)
            return currentGeneration == requestGeneration
                && self.isCurrentGateway(requestClient, at: locationID)
        }
        do {
            let response = try await requestClient.listSecrets()
            guard requestIsCurrent() else { return }
            if locationID == .local {
                secretBackend = response.backend
                storedSecrets = response.secrets
            } else {
                remoteSecretBackends[locationID] = response.backend
                remoteStoredSecrets[locationID] = response.secrets
            }
        } catch {
            guard requestIsCurrent() else { return }
            if locationID == .local {
                secretBackend = "unknown"
            } else {
                remoteSecretBackends[locationID] = "unknown"
            }
        }
    }

    /// Returns true when the list now REFLECTS server truth (incl. the honest
    /// 501 empty state); false on transport failure (last-known rows kept) so
    /// the ping watermark can surrender instead of dropping future pings.
    @discardableResult
    func refreshThreads() async -> Bool {
        guard let requestClient = client else { return false }
        let requestGeneration = connectionGeneration
        let requestIsCurrent = {
            self.connectionGeneration == requestGeneration && self.client === requestClient
        }
        do {
            let list = try await requestClient.listThreads()
            guard requestIsCurrent() else { return false }
            threads = list.threads
            projectListingProblems = list.problems
            if list.droppedThreads > 0 {
                // Per-row salvage disclosed: the store carried rows this
                // app build cannot decode, so disclose it instead of hiding it.
                threadStatus = "\(list.droppedThreads) thread(s) could not be decoded by this app version and are hidden."
            } else if threadStatus?.contains("could not be decoded") == true {
                threadStatus = nil
            }
            return true
        } catch let GatewayError.http(status, _) where status == 501 {
            guard requestIsCurrent() else { return false }
            threads = []
            projectListingProblems = []
            return true
        } catch {
            guard requestIsCurrent() else { return false }
            // A transport/decode failure is not an empty thread list: retain
            // last-known rows and surface the failure.
            threadStatus = "Could not refresh threads: \(userMessage(for: error))"
            return false
        }
    }
}
