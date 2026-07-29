/// Shared lifecycle for an explicit location-scoped projection load. Domain
/// owners keep separate state dictionaries; the vocabulary stays one small,
/// truthful contract across Settings and Accounts.
enum ProjectionLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}
