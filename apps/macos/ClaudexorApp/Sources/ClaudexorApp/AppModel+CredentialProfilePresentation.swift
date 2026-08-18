import ClaudexorKit

// MARK: - Credential profile presentation

extension AppModel {
    // MARK: Footer profile (M5c) — the active credential identity in the sidebar

    /// The harness + credential profile the NEXT turn of the current thread/draft
    /// will authenticate as, resolved from the wire (thread sticky > draft). The
    /// profile name is looked up in the registered profiles; nil = the engine's
    /// automatic account routing (no pinned profile). Truth from the wire only.
    var activeAccountFooter: (harnessLabel: String, accountLabel: String)? {
        guard let harnessId = effectivePrimaryHarness else { return nil }
        let label = HarnessFamily(rawValue: harnessId).label
        let profileId = selectedThreadId == nil
            ? draftCredentialProfileId
            : currentThread?.credentialProfileId
        let account = AccountsPresentation.composerAccountSegment(
            model: self, harnessId: harnessId, pinnedProfileId: profileId)
        return (label, account.label)
    }

    /// The human ACCOUNT label for a native thread session (QA-065): resolve the
    /// session's credential `profileId` against the loaded non-secret profile
    /// registry to a display name, falling back to the raw id if the row is
    /// absent. Under the unified account model every new session carries its
    /// resolved account row id; a nil profileId is a LEGACY default-store
    /// session recorded before the startup migration (or by an old engine).
    /// Resume never crosses accounts, so this is which account owns each
    /// resumable session.
    func sessionAccountLabel(harnessId: String, profileId: String?) -> String {
        guard let profileId else { return "Legacy default login" }
        let name = activeCredentialProfiles.first {
            $0.profile.profileId == profileId && $0.profile.harnessId == harnessId
        }?.profile.displayName
        return name ?? profileId
    }
}
