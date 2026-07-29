extension AuthSheet {
    init(target: AuthSheetTarget) {
        self.init(
            family: target.family,
            profileId: target.profileId,
            autoStartLogin: target.autoStartLogin
        )
    }
}
