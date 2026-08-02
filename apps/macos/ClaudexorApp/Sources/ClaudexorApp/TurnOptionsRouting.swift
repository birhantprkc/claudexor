import Foundation

extension TurnOptions {
    /// The routing choices shared by every user action that starts a turn.
    /// Card actions must not inherit hidden strategy/write/review knobs from the
    /// main composer, but model, auth route, and effort still mean "this turn".
    var routingOverridesOnly: TurnOptions {
        var projected = TurnOptions()
        projected.models = models
        projected.authRoute = authRoute
        projected.effort = effort
        return projected
    }
}
