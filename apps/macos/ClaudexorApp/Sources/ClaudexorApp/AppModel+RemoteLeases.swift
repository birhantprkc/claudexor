import ClaudexorKit
import Foundation

struct RemoteDirectoryBrowserRequest: Identifiable, Equatable {
    let lease: RemoteActionLease

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }
}

struct RemoteDirectoryLoadReceipt {
    let token: UUID
    let action: RemoteActionLease
    let client: GatewayClient
}

@MainActor
final class RemoteDirectoryLoadLane {
    private var currentToken: UUID?

    func begin(
        action: RemoteActionLease,
        client: GatewayClient
    ) -> RemoteDirectoryLoadReceipt {
        let receipt = RemoteDirectoryLoadReceipt(
            token: UUID(), action: action, client: client)
        currentToken = receipt.token
        return receipt
    }

    func owns(_ receipt: RemoteDirectoryLoadReceipt) -> Bool {
        currentToken == receipt.token
    }

    func accepts(_ receipt: RemoteDirectoryLoadReceipt, in model: AppModel) -> Bool {
        owns(receipt)
            && model.remoteActionIsCurrent(receipt.action, client: receipt.client)
    }
}

enum RemoteActionLane: Hashable, Sendable {
    case projectRegistration
    case setupLogin
    case harnessInstall
    case preview
    case directoryBrowser
}

enum RemoteActionOwnerKey: Hashable, Sendable {
    case global(RemoteActionLane)
    case connection(RemoteActionLane, UUID)
}

/// One opaque receipt for an async action that may cross actor suspension
/// points. The lane token orders same-epoch actions; the connection generation
/// prevents a response from crossing disconnect/reconnect.
struct RemoteActionLease: Hashable, Sendable {
    let owner: RemoteActionOwnerKey
    let lane: RemoteActionLane
    let connectionID: UUID
    let generation: Int
    let token: UUID

    init(
        lane: RemoteActionLane,
        connectionID: UUID,
        generation: Int,
        token: UUID,
        owner: RemoteActionOwnerKey? = nil
    ) {
        self.owner = owner
            ?? (lane == .projectRegistration
                ? .connection(lane, connectionID)
                : .global(lane))
        self.lane = lane
        self.connectionID = connectionID
        self.generation = generation
        self.token = token
    }
}

enum RemoteTerminalPurpose: Equatable {
    case authentication(UUID, Int)
    case shell
    case setup(RemoteActionLease, String)
    case install(RemoteActionLease, String)
    case log

    var blocksDismissalWhileRunning: Bool {
        switch self {
        case .authentication, .setup, .install:
            return true
        case .shell, .log:
            return false
        }
    }
}

struct RemoteTerminalPresentationLease: Hashable, Sendable {
    let token: UUID
    let connectionID: UUID
}

struct RemoteTerminalSheetRequest: Identifiable, Equatable {
    let id: UUID
    let title: String
    let invocation: SSHInvocation
    let purpose: RemoteTerminalPurpose
    let presentationLease: RemoteTerminalPresentationLease?

    init(
        id: UUID = UUID(),
        title: String,
        invocation: SSHInvocation,
        purpose: RemoteTerminalPurpose,
        presentationLease: RemoteTerminalPresentationLease? = nil
    ) {
        self.id = presentationLease?.token ?? id
        self.title = title
        self.invocation = invocation
        self.purpose = purpose
        self.presentationLease = presentationLease
    }
}

struct RemotePreviewRequest: Identifiable, Equatable {
    let lease: RemoteActionLease
    let localPort: Int
    let remotePort: Int

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }
}

struct RemoteDeviceLoginRequest: Identifiable, Equatable {
    let lease: RemoteActionLease
    let jobID: String

    var id: UUID { lease.token }
    var connectionID: UUID { lease.connectionID }
}

/// Semantic identity of one setup/login job. The daemon intentionally reuses
/// an active job for the same target even when HTTP idempotency keys differ, so
/// UI invocation identity alone is not enough to decide who may cancel it.
struct RemoteSetupLoginTarget: Equatable {
    let connectionID: UUID
    let harness: String
    let profileID: String?
    let transport: String
    let loginFlow: String?
}

struct RemoteSetupJobOwnership: Equatable {
    var lease: RemoteActionLease
    let target: RemoteSetupLoginTarget
    var jobID: String?
}

/// Ownership receipt for the local port forward serving one remote daemon
/// epoch. A stale cleanup may close its own forward, never a newer generation's.
struct RemoteControlForwardLease: Sendable {
    let generation: Int
    let forward: SSHForward
}

struct RemotePreviewForwardLease: Sendable, Equatable {
    let action: RemoteActionLease
    let forward: SSHForward
}

extension AppModel {
    func beginRemoteSetupJobOwnership(
        lease: RemoteActionLease,
        target: RemoteSetupLoginTarget
    ) {
        let inherited = remoteSetupJobOwnership?.target == target
            ? remoteSetupJobOwnership?.jobID
            : nil
        remoteSetupJobOwnership = RemoteSetupJobOwnership(
            lease: lease, target: target, jobID: inherited)
    }

    /// A response for a superseded same-target request transfers cleanup to the
    /// current owner. A different target keeps its own job and may clean it up.
    func recordRemoteSetupJob(
        _ jobID: String,
        lease: RemoteActionLease,
        target: RemoteSetupLoginTarget
    ) {
        guard var owner = remoteSetupJobOwnership else { return }
        if owner.lease == lease {
            owner.jobID = jobID
        } else if owner.target == target, owner.jobID == nil {
            owner.jobID = jobID
        } else {
            return
        }
        remoteSetupJobOwnership = owner
    }

    /// Return the one job this caller still owns and must cancel. A job already
    /// transferred to a same-target waiter or an exact visible presentation is
    /// never cancelled by the stale predecessor.
    func finishRemoteSetupJobOwnership(
        lease: RemoteActionLease,
        target: RemoteSetupLoginTarget,
        createdJobID: String?,
        handedOff: Bool
    ) -> String? {
        let owner = remoteSetupJobOwnership
        let ownedJobID = owner?.lease == lease ? (owner?.jobID ?? createdJobID) : createdJobID
        if owner?.lease == lease {
            remoteSetupJobOwnership = nil
        }
        guard !handedOff, let jobID = ownedJobID else { return nil }
        if let owner,
           owner.lease != lease,
           owner.target == target,
           owner.jobID == jobID
        {
            return nil
        }
        if remoteDeviceLogin?.jobID == jobID { return nil }
        if let request = remoteTerminalSheet,
           case .setup(_, let presentedJobID) = request.purpose,
           presentedJobID == jobID
        {
            return nil
        }
        return jobID
    }

    /// Admit the newest action in one UI lane. These lanes each project into a
    /// single global sheet/prompt, so a newer action supersedes an older action
    /// even when it targets another connection.
    func beginRemoteAction(
        _ lane: RemoteActionLane,
        connectionID: UUID
    ) -> RemoteActionLease? {
        guard remoteConnections.contains(where: { $0.id == connectionID }) else { return nil }
        let owner: RemoteActionOwnerKey =
            lane == .projectRegistration
            ? .connection(lane, connectionID)
            : .global(lane)
        let lease = RemoteActionLease(
            lane: lane,
            connectionID: connectionID,
            generation: remoteConnectionGenerations[connectionID] ?? 0,
            token: UUID(),
            owner: owner)
        remoteActionLeases[owner] = lease
        return lease
    }

    func remoteActionIsCurrent(
        _ lease: RemoteActionLease,
        client requestClient: GatewayClient? = nil
    ) -> Bool {
        guard remoteActionLeases[lease.owner] == lease,
              remoteConnectionGenerations[lease.connectionID] ?? 0 == lease.generation,
              remoteConnections.contains(where: { $0.id == lease.connectionID })
        else { return false }
        guard let requestClient else { return true }
        return isCurrentGateway(requestClient, at: .remote(lease.connectionID))
    }

    /// Preserve user invocation order across a reconnect that advances the
    /// connection generation. Only the still-owning token can rebind; an older
    /// waiter can never revive itself after a newer action or disconnect.
    func rebindRemoteActionToCurrentGeneration(
        _ lease: RemoteActionLease
    ) -> RemoteActionLease? {
        guard let current = remoteActionLeases[lease.owner],
              current.token == lease.token,
              current.connectionID == lease.connectionID,
              remoteConnections.contains(where: { $0.id == lease.connectionID })
        else { return nil }
        let rebound = RemoteActionLease(
            lane: lease.lane,
            connectionID: lease.connectionID,
            generation: remoteConnectionGenerations[lease.connectionID] ?? 0,
            token: lease.token,
            owner: lease.owner)
        remoteActionLeases[lease.owner] = rebound
        return rebound
    }

    func finishRemoteAction(_ lease: RemoteActionLease) {
        guard remoteActionLeases[lease.owner] == lease else { return }
        remoteActionLeases.removeValue(forKey: lease.owner)
    }

    /// Retire before disconnect performs any I/O. Cancellation is cooperative;
    /// token invalidation is the synchronous publication fence.
    func retireRemoteActions(for connectionID: UUID) {
        let owners = remoteActionLeases.compactMap { owner, lease in
            lease.connectionID == connectionID ? owner : nil
        }
        for owner in owners {
            remoteActionLeases.removeValue(forKey: owner)
        }
    }

    func beginRemoteTerminalPresentation(
        connectionID: UUID
    ) -> RemoteTerminalPresentationLease? {
        guard remoteConnections.contains(where: { $0.id == connectionID }) else { return nil }
        let lease = RemoteTerminalPresentationLease(
            token: UUID(), connectionID: connectionID)
        remoteTerminalPresentationLease = lease
        return lease
    }

    func remoteTerminalPresentationIsCurrent(
        _ lease: RemoteTerminalPresentationLease
    ) -> Bool {
        remoteTerminalPresentationLease == lease
            && remoteConnections.contains(where: { $0.id == lease.connectionID })
    }

    @discardableResult
    func presentRemoteTerminal(
        _ lease: RemoteTerminalPresentationLease,
        title: String,
        invocation: SSHInvocation,
        purpose: RemoteTerminalPurpose
    ) -> Bool {
        guard remoteTerminalPresentationIsCurrent(lease) else { return false }
        remoteTerminalSheet = RemoteTerminalSheetRequest(
            title: title,
            invocation: invocation,
            purpose: purpose,
            presentationLease: lease)
        return true
    }

    func finishRemoteTerminalPresentation(_ lease: RemoteTerminalPresentationLease) {
        guard remoteTerminalPresentationLease == lease else { return }
        remoteTerminalPresentationLease = nil
    }

    func dismissRemoteTerminal(_ request: RemoteTerminalSheetRequest) {
        if remoteTerminalSheet?.id == request.id {
            remoteTerminalSheet = nil
        }
        if let lease = request.presentationLease {
            finishRemoteTerminalPresentation(lease)
        }
    }

    func retireRemoteTerminalPresentation(for connectionID: UUID) {
        guard let lease = remoteTerminalPresentationLease,
              lease.connectionID == connectionID
        else { return }
        remoteTerminalPresentationLease = nil
        if remoteTerminalSheet?.presentationLease == lease {
            remoteTerminalSheet = nil
        }
    }

    func recordSupersededRemoteAuthentication(
        connectionID: UUID,
        generation: Int,
        presentation: RemoteTerminalPresentationLease
    ) {
        finishRemoteTerminalPresentation(presentation)
        guard remoteConnectionGenerations[connectionID] == generation else { return }
        setRemoteState(
            connectionID,
            .needsInteraction,
            message: "SSH needs authentication. Close the current terminal and click Connect.")
    }

    /// The only reconnect-time remote client-slot mutation. Applicability is a
    /// receipt from one daemon epoch and must be retired before another client
    /// can occupy the same logical location.
    func adoptRemoteClientForReconnect(
        _ newClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) {
        if let currentClient = remoteClients[locationID], currentClient !== newClient {
            retireRunApplicability(at: locationID)
            retireHarnessProjection(at: locationID)
        }
        remoteClients[locationID] = newClient
    }
}
