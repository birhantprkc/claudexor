import Foundation

// MARK: - Harness status / auth-source / model DTOs
//
// Extracted from `Models.swift` so the harness readiness + model-truth DTOs
// stay a small, single-owner unit (INV-124 readability ratchet).

public struct HarnessStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let status: String
    public let manifest: JSONValue?
    public let enabledIntents: [String]
    /// Intents this harness is ACTUALLY routable for right now — the SERVER's
    /// doctor-gated availability truth (R8/W14). Surfaces read this field and
    /// never re-derive availability from status+intents. An empty array means
    /// "routes nothing" (degraded/unauth'd harness, or a legacy daemon that
    /// predates the field) — fail-closed, never "ready".
    public let routableIntents: [String]
    public let disabledIntents: [String]
    public let checks: [HarnessCheck]
    public let reasons: [String]?
    /// Doctor-backed readiness for each concrete authentication source. An
    /// empty array means a legacy daemon (or a probe that reported no source
    /// detail), never "ready".
    public let authSources: [HarnessAuthSource]
    /// The daemon-normalized display list (W4.7): what surfaces RENDER —
    /// typed rows (kind/title/status/detail), never parsed strings or
    /// id-substring matches. Empty means a legacy daemon; raw checks/reasons
    /// remain for "copy raw" evidence.
    public let readiness: [ReadinessCheck]
    /// The user's configured per-harness default model, if any.
    public let configuredModel: String?
    /// Strict truth-source verdict for `configuredModel` ("ok"/"rejected" +
    /// actionable message) — the UI renders the doctor's honesty.
    public let configuredModelCheck: HarnessModelCheck?
    /// Engine-owned readiness for the selected runtime/harness Delegate belt.
    /// Absence means an older runtime and therefore fails closed in the UI.
    public let delegation: HarnessDelegationCapability?

    enum CodingKeys: String, CodingKey {
        case id, status, manifest, enabledIntents, routableIntents, disabledIntents, checks, reasons, authSources, readiness, configuredModel, configuredModelCheck, delegation
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        manifest = try c.decodeIfPresent(JSONValue.self, forKey: .manifest)
        enabledIntents = try c.decodeIfPresent([String].self, forKey: .enabledIntents) ?? []
        routableIntents = try c.decodeIfPresent([String].self, forKey: .routableIntents) ?? []
        disabledIntents = try c.decodeIfPresent([String].self, forKey: .disabledIntents) ?? []
        checks = try c.decodeIfPresent([HarnessCheck].self, forKey: .checks) ?? []
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons)
        authSources = try c.decodeIfPresent([HarnessAuthSource].self, forKey: .authSources) ?? []
        readiness = try c.decodeIfPresent([ReadinessCheck].self, forKey: .readiness) ?? []
        configuredModel = try c.decodeIfPresent(String.self, forKey: .configuredModel)
        configuredModelCheck = try c.decodeIfPresent(HarnessModelCheck.self, forKey: .configuredModelCheck)
        delegation = try c.decodeIfPresent(HarnessDelegationCapability.self, forKey: .delegation)
    }
}

/// `HarnessStatusDto.delegation` / `CatalogHarness.delegation`. The reason is
/// a closed engine vocabulary (`ready`, `runtime_unavailable`, or
/// `manifest_unsupported`); the app displays the server-projected remediation
/// instead of reconstructing install/update advice.
public struct HarnessDelegationCapability: Codable, Sendable, Equatable, Hashable {
    public let available: Bool
    public let reason: String
    public let remediation: String?
    public let requiresFullAccess: Bool

    public init(available: Bool, reason: String, remediation: String? = nil, requiresFullAccess: Bool) {
        self.available = available
        self.reason = reason
        self.remediation = remediation
        self.requiresFullAccess = requiresFullAccess
    }
}

/// One daemon-normalized readiness row (schema `ReadinessCheckDto`).
public struct ReadinessCheck: Codable, Sendable, Equatable, Hashable {
    /// "binary" | "auth" | "smoke" | "model" | "probe" — typed classification
    /// from the daemon's table; the UI switches on it, never on id substrings.
    public let kind: String
    public let id: String
    public let title: String
    /// "pass" | "fail" | "skip".
    public let status: String
    public let detail: String?

    public init(kind: String, id: String, title: String, status: String, detail: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.status = status
        self.detail = detail
    }
}

public struct HarnessAuthSource: Codable, Sendable, Equatable, Hashable {
    public let source: String
    public let availability: String
    public let verification: String
    public let detail: String?

    public init(source: String, availability: String, verification: String, detail: String? = nil) {
        self.source = source
        self.availability = availability
        self.verification = verification
        self.detail = detail
    }

    /// Native session readiness is proven only by the typed doctor verdict.
    /// Credential presence alone is deliberately insufficient.
    public var isVerifiedNativeSession: Bool {
        source == "native_session" && availability == "available" && verification == "passed"
    }
}

public struct HarnessModelCheck: Codable, Sendable, Equatable {
    public let status: String
    public let message: String?
}

public struct HarnessCheck: Codable, Sendable, Equatable {
    public let id: String
    public let status: String
    public let detail: String?
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
}

/// One enumerable model a harness offers. Mirrors the control-api `HarnessModel`
/// (deliberately small: only fields a real `GET /v1/models` enumeration can
/// honestly populate). `label`/`contextWindow` are nullable on the wire.
public struct HarnessModel: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String?
    public let contextWindow: Int?
    /// Credential routes this model is annotated for (W11: "local_session" /
    /// "api_key"). nil = unannotated, offered on every route.
    public let routes: [String]?

    enum CodingKeys: String, CodingKey {
        case id, label, routes
        case contextWindow = "context_window"
    }

    public init(id: String, label: String? = nil, contextWindow: Int? = nil, routes: [String]? = nil) {
        self.id = id
        self.label = label
        self.contextWindow = contextWindow
        self.routes = routes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow)
        routes = try c.decodeIfPresent([String].self, forKey: .routes)
    }
}

/// Menu-facing presentation for enumerable models (issue #53). An open
/// `Picker` popup is an NSMenu, and an NSMenu sizes to its WIDEST item — a
/// `.frame` on the closed control cannot bound it. Vendor catalogs are free
/// text with no length contract (Cursor ships very long labels), so the menu
/// STRING itself carries the guarantee. Kept in ClaudexorKit as a pure value
/// transform so the cap semantics are unit-tested without the UI and run in
/// CI (`QuotaPresentation` precedent).
public enum HarnessModelPresentation {
    /// Hard cap for one menu title. 48 characters keeps the widest possible
    /// menu item close to the closed control's `modelPickerWidth` while
    /// leaving both the human-label prefix and the id tail recognizable.
    public static let menuTitleMaxCharacters = 48

    /// The ONE shared "label (id)" derivation for catalog-fed picker menus
    /// (composer models rows + Settings model override): the id alone when no
    /// distinct label exists; whitespace runs collapse to single spaces (a
    /// menu item must never carry a newline); overflow truncates in the
    /// MIDDLE so the family prefix AND the differentiating id tail both stay
    /// readable.
    public static func menuTitle(label: String?, id: String) -> String {
        let name = label.flatMap { $0.isEmpty ? nil : $0 } ?? id
        let full = name == id ? name : "\(name) (\(id))"
        let collapsed = full.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard collapsed.count > menuTitleMaxCharacters else { return collapsed }
        let keep = menuTitleMaxCharacters - 1
        let head = (keep + 1) / 2
        return "\(collapsed.prefix(head))…\(collapsed.suffix(keep - head))"
    }
}

/// Models enumerable for one harness (GET /harnesses/:id/models). `source` is
/// honest about provenance: "api" when the adapter implemented a real
/// enumeration, "manifest" reserved for a future manifest list, "none" when the
/// adapter cannot enumerate (the list is then empty).
public struct HarnessModelsResponse: Codable, Sendable, Equatable {
    public let harnessId: String
    public let models: [HarnessModel]
    /// "api" | "manifest" | "none".
    public let source: String
    /// Freshness note for manifest-sourced lists: the vendor CLI version the
    /// known-model hints were last verified against (nil for api/none).
    public let verifiedAgainst: String?

    enum CodingKeys: String, CodingKey { case harnessId, models, source, verifiedAgainst }

    public init(harnessId: String, models: [HarnessModel] = [], source: String, verifiedAgainst: String? = nil) {
        self.harnessId = harnessId
        self.models = models
        self.source = source
        self.verifiedAgainst = verifiedAgainst
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harnessId = try c.decode(String.self, forKey: .harnessId)
        models = try c.decodeIfPresent([HarnessModel].self, forKey: .models) ?? []
        source = try c.decode(String.self, forKey: .source)
        verifiedAgainst = try c.decodeIfPresent(String.self, forKey: .verifiedAgainst)
    }

    /// True when a truth source exists (strict model-truth validation: no truth source = the
    /// harness runs its default only; there is no free-text model entry).
    public var canEnumerate: Bool { source != "none" && !models.isEmpty }
}
