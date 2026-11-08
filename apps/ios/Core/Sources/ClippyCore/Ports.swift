import Foundation

/// Typed service boundaries. View models depend on these, never on URLSession or SDK dictionaries.
public protocol JournalRepository: Sendable {
    func days(cursor: String?) async throws -> Days
    func day(_ id: String) async throws -> Day
    func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection
    func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction
    /// Image bytes for one capture, fetched through a short-lived read grant.
    func captureImage(_ captureID: String) async throws -> Data
}

public protocol DeviceService: Sendable {
    func devices() async throws -> Devices
    func device(_ id: String) async throws -> DeviceDetail
    func configure(deviceID: String, configuration: Configuration, key: String) async throws -> DeviceDetail
}

public protocol SyncService: Sendable {
    func requestSync(deviceID: String, key: String) async throws -> SyncRequest
    func sync(_ id: String) async throws -> SyncRequest
    func cancelSync(_ id: String, key: String) async throws -> SyncRequest
}

public protocol PairingService: Sendable {
    func claim(_ input: ClaimInput, key: String) async throws -> Claim
    func confirm(claimID: String, proof: ClaimProof, key: String) async throws -> Claim
}

public protocol AccountService: Sendable {
    func profile() async throws -> Profile
    func updatePreferences(_ preferences: Preferences, key: String) async throws -> Profile
    func deleteAccount(key: String) async throws -> DeletionJob
    func deleteDay(_ id: String, key: String) async throws -> DeletionJob
    func deleteCapture(_ id: String, key: String) async throws -> DeletionJob
    func deletionJob(_ id: String) async throws -> DeletionJob
}

/// Everything the app talks to. One adapter per environment: local HTTP, AWS HTTP, fixture, demo.
public typealias ClippyServices = JournalRepository & DeviceService & SyncService & PairingService & AccountService

public protocol AuthSession: Sendable {
    /// Returns a bearer token, refreshing if needed. Throws `RepositoryFailure.unauthorized` when sign-in is required.
    func authorization() async throws -> String
}

public protocol CalendarSource: Sendable { func snapshot() async throws -> CalendarBundle? }

public enum RepositoryFailure: Error, Sendable, Equatable {
    /// A contract error envelope from the server: stable code plus optional current revision.
    case server(String, Int?)
    case offline
    case readOnly
    /// Sign-in missing or expired.
    case unauthorized
    /// The server does not implement this route yet (501). Shown honestly instead of pretending success.
    case unavailable

    public var code: String {
        switch self {
        case .server(let code, _): code
        case .offline: "OFFLINE"
        case .readOnly: "READ_ONLY"
        case .unauthorized: "UNAUTHENTICATED"
        case .unavailable: "NOT_IMPLEMENTED"
        }
    }
}

public enum OperationID {
    /// Matches the contract `Id` pattern `^[a-z][a-z0-9_]{2,95}$`.
    public static func make(prefix: String = "op") -> String {
        prefix + "_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
