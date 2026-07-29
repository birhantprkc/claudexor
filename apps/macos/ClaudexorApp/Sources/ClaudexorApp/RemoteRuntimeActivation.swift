import ClaudexorKit
import Foundation

/// Opaque ownership for one remote-runtime pointer transition. A connection id
/// is not enough: actor reentrancy can otherwise let an older caller commit or
/// roll back a newer caller's activation after either call suspends for SSH.
struct RemoteRuntimeActivationLease: Hashable, Sendable {
    fileprivate let id: UUID
    let connectionID: UUID
}

/// One explicit publication barrier for a tunneled remote client. A regular
/// reconnect needs only a successful Control handshake; a reconnect that owns
/// a freshly activated runtime must also commit that exact activation before
/// any client or daemon projection can become visible to the app.
struct RemoteRuntimePublicationGate: Equatable, Sendable {
    private(set) var handshakeAccepted = false
    private(set) var activationCommitted: Bool

    init(requiresActivationCommit: Bool) {
        activationCommitted = !requiresActivationCommit
    }

    mutating func acceptHandshake() {
        handshakeAccepted = true
    }

    @discardableResult
    mutating func acceptActivationCommit() -> Bool {
        guard handshakeAccepted else { return false }
        activationCommitted = true
        return true
    }

    var mayPublish: Bool {
        handshakeAccepted && activationCommitted
    }
}

/// Installation reached an activated candidate, but the immediate exact
/// rollback also failed. The caller receives the same opaque lease so it can
/// retry recovery; the installer keeps that lease pending and blocks any newer
/// activation until it settles.
struct RemoteRuntimeRecoveryRequired: Error, LocalizedError, Sendable {
    let lease: RemoteRuntimeActivationLease
    let primaryMessage: String
    let recoveryMessage: String

    var errorDescription: String? {
        primaryMessage + " Runtime recovery also failed: " + recoveryMessage
    }
}

/// The small synchronous authority behind the install actor. Every transition
/// happens before an SSH await, so reentrant calls can only observe a claimed,
/// pending, or settling lease and can never replace it.
struct RemoteRuntimeActivationState: Sendable {
    enum Phase: Equatable, Sendable {
        case installing
        case uncertain
        case reconciling
        case pending
        case settling
    }

    struct Payload: Sendable {
        let candidateTarget: String
        let candidate: RemoteRuntimeProbe
        let previousTarget: String?
        let previous: RemoteRuntimeProbe?
    }

    private struct Record: Sendable {
        let lease: RemoteRuntimeActivationLease
        var phase: Phase
        var payload: Payload?
    }

    private var records: [UUID: Record] = [:]

    mutating func claim(connectionID: UUID) throws -> RemoteRuntimeActivationLease {
        guard records[connectionID] == nil else {
            throw SSHConnectionError.unavailable(
                "another runtime activation is already in progress for this host")
        }
        let lease = RemoteRuntimeActivationLease(id: UUID(), connectionID: connectionID)
        records[connectionID] = Record(lease: lease, phase: .installing, payload: nil)
        return lease
    }

    /// Bind the exact before/candidate closure before the mutating SSH command
    /// starts. The phase stays `installing`, so a reentrant recovery cannot
    /// inspect a pointer while the remote CAS is still running; if its response
    /// is lost, `markUncertain` makes the same payload recoverable.
    mutating func prepareMutation(
        _ payload: Payload,
        for lease: RemoteRuntimeActivationLease
    ) throws {
        guard var record = exactRecord(for: lease),
              record.phase == .installing,
              record.payload == nil
        else { throw staleLeaseError() }
        record.payload = payload
        records[lease.connectionID] = record
    }

    mutating func confirmMutation(_ lease: RemoteRuntimeActivationLease) throws {
        guard var record = exactRecord(for: lease),
              record.phase == .installing,
              record.payload != nil
        else { throw staleLeaseError() }
        record.phase = .pending
        records[lease.connectionID] = record
    }

    mutating func markUncertain(_ lease: RemoteRuntimeActivationLease) throws {
        guard var record = exactRecord(for: lease),
              record.phase == .installing,
              record.payload != nil
        else { throw staleLeaseError() }
        record.phase = .uncertain
        records[lease.connectionID] = record
    }

    mutating func beginUncertainReconciliation(
        _ lease: RemoteRuntimeActivationLease
    ) throws -> Payload {
        guard var record = exactRecord(for: lease),
              record.phase == .uncertain,
              let payload = record.payload
        else { throw staleLeaseError() }
        record.phase = .reconciling
        records[lease.connectionID] = record
        return payload
    }

    mutating func uncertainReconciliationFailed(_ lease: RemoteRuntimeActivationLease) {
        guard var record = exactRecord(for: lease), record.phase == .reconciling else { return }
        record.phase = .uncertain
        records[lease.connectionID] = record
    }

    mutating func confirmUncertainCandidate(_ lease: RemoteRuntimeActivationLease) throws {
        guard var record = exactRecord(for: lease), record.phase == .reconciling else {
            throw staleLeaseError()
        }
        record.phase = .pending
        records[lease.connectionID] = record
    }

    mutating func resolveUnchangedPointer(_ lease: RemoteRuntimeActivationLease) throws {
        guard let record = exactRecord(for: lease), record.phase == .reconciling else {
            throw staleLeaseError()
        }
        records.removeValue(forKey: lease.connectionID)
    }

    mutating func beginSettlement(
        _ lease: RemoteRuntimeActivationLease
    ) throws -> Payload {
        guard var record = exactRecord(for: lease),
              record.phase == .pending,
              let payload = record.payload
        else { throw staleLeaseError() }
        record.phase = .settling
        records[lease.connectionID] = record
        return payload
    }

    mutating func settlementFailed(_ lease: RemoteRuntimeActivationLease) {
        guard var record = exactRecord(for: lease), record.phase == .settling else { return }
        record.phase = .pending
        records[lease.connectionID] = record
    }

    mutating func commit(_ lease: RemoteRuntimeActivationLease) throws {
        guard let record = exactRecord(for: lease), record.phase == .pending else {
            throw staleLeaseError()
        }
        records.removeValue(forKey: lease.connectionID)
    }

    mutating func finishSettlement(_ lease: RemoteRuntimeActivationLease) throws {
        guard let record = exactRecord(for: lease), record.phase == .settling else {
            throw staleLeaseError()
        }
        records.removeValue(forKey: lease.connectionID)
    }

    mutating func abandon(_ lease: RemoteRuntimeActivationLease) {
        guard exactRecord(for: lease) != nil else { return }
        records.removeValue(forKey: lease.connectionID)
    }

    func phase(for lease: RemoteRuntimeActivationLease) -> Phase? {
        exactRecord(for: lease)?.phase
    }

    func recoverableLease(connectionID: UUID) -> RemoteRuntimeActivationLease? {
        guard let record = records[connectionID],
              record.phase == .pending || record.phase == .uncertain
        else { return nil }
        return record.lease
    }

    func lease(connectionID: UUID) -> RemoteRuntimeActivationLease? {
        records[connectionID]?.lease
    }

    private func exactRecord(for lease: RemoteRuntimeActivationLease) -> Record? {
        guard let record = records[lease.connectionID], record.lease == lease else { return nil }
        return record
    }

    private func staleLeaseError() -> SSHConnectionError {
        .unavailable("the runtime activation lease is stale or already settled")
    }
}
