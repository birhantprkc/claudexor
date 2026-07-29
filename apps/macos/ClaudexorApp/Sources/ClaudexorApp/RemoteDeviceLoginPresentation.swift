import ClaudexorKit
import SwiftUI

func remoteDeviceLoginSnapshotAfterPollFailure(
    _ snapshot: SetupJobSnapshot?
) -> SetupJobSnapshot? {
    guard let snapshot else { return nil }
    return SetupJobSnapshot(
        job: snapshot.job, cursor: snapshot.cursor, sequence: snapshot.sequence)
}

/// Keeps the setup-job outcome and the independently refreshed doctor truth
/// visible at once. A recovered native session is ready, but its failed setup
/// job never gets relabeled as a verified setup.
enum RemoteDeviceLoginTerminalPresentation: Equatable {
    case verified
    case readyWithWarning
    case failed

    init(
        jobState: SetupJobState,
        selectionReason: AuthCapabilitySelectionReason?,
        effectiveRoute: CredentialRoute?,
        effectiveSource: AuthSourceKind?,
        nativeSessionVerified: Bool,
        harnessRoutable: Bool
    ) {
        if jobState == .succeeded {
            self = .verified
        } else if remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: jobState,
            selectionReason: selectionReason,
            effectiveRoute: effectiveRoute,
            effectiveSource: effectiveSource,
            nativeSessionVerified: nativeSessionVerified,
            harnessRoutable: harnessRoutable)
        {
            self = .readyWithWarning
        } else {
            self = .failed
        }
    }

    var label: String {
        switch self {
        case .verified: "Login verified"
        case .readyWithWarning: "Signed in; setup check failed"
        case .failed: "Login failed"
        }
    }

    var systemImage: String {
        switch self {
        case .verified: "checkmark.circle.fill"
        case .readyWithWarning: "exclamationmark.triangle.fill"
        case .failed: "xmark.circle"
        }
    }

    var color: Color {
        self == .verified ? Theme.status(.positive) : .orange
    }
}
