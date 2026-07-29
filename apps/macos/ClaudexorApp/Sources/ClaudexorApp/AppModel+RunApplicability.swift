import ClaudexorKit

enum RunApplicabilityProjection: Equatable {
    case loading(repoRoot: String)
    case ready(ControlRunApplicabilityResponse)
    case failed(repoRoot: String, message: String)

    var repoRoot: String {
        switch self {
        case .loading(let repoRoot), .failed(let repoRoot, _): repoRoot
        case .ready(let response): response.repoRoot
        }
    }
}

extension AppModel {
    var composerRepoRoot: String {
        composerTurnStartTarget.repoRoot
    }

    var activeRunApplicabilityProjection: RunApplicabilityProjection? {
        let projection = runApplicabilityProjections[activeExecutionLocation]
        return projection?.repoRoot == composerRepoRoot ? projection : nil
    }

    /// A view-task identity that changes on location/root/connection/Git epochs.
    var runApplicabilityRefreshKey: String {
        let locationID = activeExecutionLocation
        let connectionEpoch: Int
        if let remoteID = locationID.remoteConnectionID {
            connectionEpoch = remoteConnectionGenerations[remoteID] ?? 0
        } else {
            connectionEpoch = connectionGeneration
        }
        let git = activeGitCapability
        return [
            locationID.rawValue,
            composerRepoRoot,
            String(connectionEpoch),
            git?.status ?? "unknown",
            git?.version ?? "",
        ].joined(separator: "|")
    }

    func retireRunApplicability(at locationID: ExecutionLocationID) {
        runApplicabilityGenerations[locationID] =
            (runApplicabilityGenerations[locationID] ?? 0) &+ 1
        runApplicabilityProjections.removeValue(forKey: locationID)
    }

    func refreshRunApplicability(
        repoRoot requestedRoot: String? = nil,
        locationID requestedLocationID: ExecutionLocationID? = nil,
        using preparedClient: GatewayClient? = nil
    ) async {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let repoRoot = (requestedRoot ?? composerRepoRoot)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !repoRoot.isEmpty else {
            retireRunApplicability(at: locationID)
            return
        }
        let generation = (runApplicabilityGenerations[locationID] ?? 0) &+ 1
        runApplicabilityGenerations[locationID] = generation
        guard let requestClient = preparedClient ?? gateway(for: locationID),
              isCurrentGateway(requestClient, at: locationID)
        else {
            runApplicabilityProjections[locationID] = .failed(
                repoRoot: repoRoot, message: "Engine offline — reconnect to check Git readiness.")
            return
        }
        runApplicabilityProjections[locationID] = .loading(repoRoot: repoRoot)
        do {
            let response = try await requestClient.runApplicability(repoRoot: repoRoot)
            guard runApplicabilityGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID),
                  response.repoRoot == repoRoot
            else { return }
            runApplicabilityProjections[locationID] = .ready(response)
        } catch {
            guard runApplicabilityGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID)
            else { return }
            runApplicabilityProjections[locationID] = .failed(
                repoRoot: repoRoot,
                message: "Could not verify Git readiness: \(userMessage(for: error))")
        }
    }
}
