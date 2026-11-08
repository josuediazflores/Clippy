import Foundation

/// HTTP adapter for the v1 API. Works against the local synthetic server (loopback HTTP) or a deployed API (HTTPS).
/// Every response is validated against the frozen JSON Schema before it reaches a view model.
public actor HTTPClippyClient: ClippyServices {
    private let baseURL: URL
    private let auth: any AuthSession
    private let validator: ContractValidator
    private let session: URLSession

    public init(baseURL: URL, auth: any AuthSession, schema: Data, transitions: Data, timeout: TimeInterval = 8) throws {
        guard HTTPClippyClient.isAllowed(baseURL) else { throw RepositoryFailure.server("INSECURE_BASE_URL", nil) }
        self.baseURL = baseURL
        self.auth = auth
        validator = try ContractValidator(schema: schema, transitions: transitions)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    /// Plain HTTP is allowed only on loopback. Anything else must be HTTPS.
    public static func isAllowed(_ url: URL) -> Bool {
        switch url.scheme {
        case "https": url.host != nil
        case "http": ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
        default: false
        }
    }

    private func send(path: String, method: String, body: Data?, key: String?, query: [URLQueryItem] = []) async throws -> (Data, HTTPURLResponse) {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(try await auth.authorization())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is URLError { throw RepositoryFailure.offline }
        guard let http = response as? HTTPURLResponse else { throw RepositoryFailure.offline }
        guard (200...299).contains(http.statusCode) else { throw failure(status: http.statusCode, data: data) }
        return (data, http)
    }

    private func failure(status: Int, data: Data) -> RepositoryFailure {
        let envelope = try? validator.decode(APIError.self, kind: "Error", data: data)
        let code = envelope?.error.code
        if status == 401 || code == "UNAUTHENTICATED" { return .unauthorized }
        if status == 501 || code == "NOT_IMPLEMENTED" { return .unavailable }
        // API Gateway answers routes that are not deployed with a bare 404 and no contract envelope.
        if status == 404 && envelope == nil { return .unavailable }
        return .server(code ?? "HTTP_\(status)", envelope?.error.currentRevision)
    }

    private func call<T: Decodable & Sendable>(_ type: T.Type, kind: String, path: String, method: String = "GET", body: Data? = nil, key: String? = nil, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await send(path: path, method: method, body: body, key: key, query: query)
        return try validator.decode(type, kind: kind, data: data)
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

    // MARK: Journal

    public func days(cursor: String?) async throws -> Days {
        try await call(Days.self, kind: "Days", path: "v1/days", query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    }
    public func day(_ id: String) async throws -> Day { try await call(Day.self, kind: "Day", path: "v1/days/\(id)") }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection {
        try await call(Reflection.self, kind: "Reflection", path: "v1/days/\(dayID)/reflections/\(id)", method: "PUT", body: encode(edit), key: edit.operationId)
    }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction {
        try await call(Correction.self, kind: "Correction", path: "v1/moments/\(momentID)/corrections/\(id)", method: "PUT", body: encode(edit), key: edit.operationId)
    }
    public func captureImage(_ captureID: String) async throws -> Data {
        let grant = try await call(ReadGrant.self, kind: "ReadGrant", path: "v1/captures/\(captureID)/read-url", method: "POST", key: OperationID.make(prefix: "read"))
        guard let url = URL(string: grant.readURL, relativeTo: baseURL)?.absoluteURL, HTTPClippyClient.isAllowed(url) else {
            throw RepositoryFailure.server("INVALID_READ_URL", nil)
        }
        var request = URLRequest(url: url)
        // The local server serves objects behind the same bearer. Presigned S3 URLs must not receive it.
        if url.host == baseURL.host && url.port == baseURL.port {
            request.setValue("Bearer \(try await auth.authorization())", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw RepositoryFailure.server("IMAGE_UNAVAILABLE", nil) }
            return data
        } catch is URLError { throw RepositoryFailure.offline }
    }

    // MARK: Devices and sync

    public func devices() async throws -> Devices { try await call(Devices.self, kind: "Devices", path: "v1/devices") }
    public func device(_ id: String) async throws -> DeviceDetail { try await call(DeviceDetail.self, kind: "DeviceDetail", path: "v1/devices/\(id)") }
    public func configure(deviceID: String, configuration: Configuration, key: String) async throws -> DeviceDetail {
        try await call(DeviceDetail.self, kind: "DeviceDetail", path: "v1/devices/\(deviceID)/configuration", method: "PATCH", body: encode(configuration), key: key)
    }
    public func requestSync(deviceID: String, key: String) async throws -> SyncRequest {
        try await call(SyncRequest.self, kind: "SyncRequest", path: "v1/devices/\(deviceID)/sync-requests", method: "POST", body: encode(SyncRequestInput(schemaVersion: 1, trigger: "manual")), key: key)
    }
    public func sync(_ id: String) async throws -> SyncRequest { try await call(SyncRequest.self, kind: "SyncRequest", path: "v1/sync-requests/\(id)") }
    public func cancelSync(_ id: String, key: String) async throws -> SyncRequest {
        try await call(SyncRequest.self, kind: "SyncRequest", path: "v1/sync-requests/\(id)/cancel", method: "POST", key: key)
    }

    // MARK: Pairing

    public func claim(_ input: ClaimInput, key: String) async throws -> Claim {
        try await call(Claim.self, kind: "Claim", path: "v1/device-claims", method: "POST", body: encode(input), key: key)
    }
    public func confirm(claimID: String, proof: ClaimProof, key: String) async throws -> Claim {
        try await call(Claim.self, kind: "Claim", path: "v1/device-claims/\(claimID)/confirm", method: "POST", body: encode(proof), key: key)
    }

    // MARK: Account and deletion

    public func profile() async throws -> Profile { try await call(Profile.self, kind: "Profile", path: "v1/me") }
    public func updatePreferences(_ preferences: Preferences, key: String) async throws -> Profile {
        try await call(Profile.self, kind: "Profile", path: "v1/me/preferences", method: "PATCH", body: encode(preferences), key: key)
    }
    public func deleteAccount(key: String) async throws -> DeletionJob { try await call(DeletionJob.self, kind: "DeletionJob", path: "v1/me", method: "DELETE", key: key) }
    public func deleteDay(_ id: String, key: String) async throws -> DeletionJob { try await call(DeletionJob.self, kind: "DeletionJob", path: "v1/days/\(id)", method: "DELETE", key: key) }
    public func deleteCapture(_ id: String, key: String) async throws -> DeletionJob { try await call(DeletionJob.self, kind: "DeletionJob", path: "v1/captures/\(id)", method: "DELETE", key: key) }
    public func deletionJob(_ id: String) async throws -> DeletionJob { try await call(DeletionJob.self, kind: "DeletionJob", path: "v1/deletion-jobs/\(id)") }
}

/// Synthetic local bearer. The local server accepts only `local-user-a` and `local-user-b`.
public struct StaticBearer: AuthSession {
    public let token: String
    public init(token: String) { self.token = token }
    public func authorization() async throws -> String { token }
}

/// Read-only adapter that renders one bundled fixture day. Used for state previews and UI tests.
public actor FixtureServices: ClippyServices {
    private let value: Day
    public init(data: Data) throws { value = try JSONDecoder().decode(Day.self, from: data) }
    public func days(cursor: String?) async throws -> Days { Days(schemaVersion: 1, items: [value], nextCursor: nil) }
    public func day(_ id: String) async throws -> Day { value }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection { throw RepositoryFailure.readOnly }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction { throw RepositoryFailure.readOnly }
    public func captureImage(_ captureID: String) async throws -> Data { throw RepositoryFailure.readOnly }
    public func devices() async throws -> Devices { Devices(schemaVersion: 1, items: [], nextCursor: nil) }
    public func device(_ id: String) async throws -> DeviceDetail { throw RepositoryFailure.server("NOT_FOUND", nil) }
    public func configure(deviceID: String, configuration: Configuration, key: String) async throws -> DeviceDetail { throw RepositoryFailure.readOnly }
    public func requestSync(deviceID: String, key: String) async throws -> SyncRequest { throw RepositoryFailure.readOnly }
    public func sync(_ id: String) async throws -> SyncRequest { throw RepositoryFailure.readOnly }
    public func cancelSync(_ id: String, key: String) async throws -> SyncRequest { throw RepositoryFailure.readOnly }
    public func claim(_ input: ClaimInput, key: String) async throws -> Claim { throw RepositoryFailure.readOnly }
    public func confirm(claimID: String, proof: ClaimProof, key: String) async throws -> Claim { throw RepositoryFailure.readOnly }
    public func profile() async throws -> Profile { Profile(schemaVersion: 1, journalTimeZone: "UTC", revision: 1, retentionDays: 30, consentRevision: 0) }
    public func updatePreferences(_ preferences: Preferences, key: String) async throws -> Profile { throw RepositoryFailure.readOnly }
    public func deleteAccount(key: String) async throws -> DeletionJob { throw RepositoryFailure.readOnly }
    public func deleteDay(_ id: String, key: String) async throws -> DeletionJob { throw RepositoryFailure.readOnly }
    public func deleteCapture(_ id: String, key: String) async throws -> DeletionJob { throw RepositoryFailure.readOnly }
    public func deletionJob(_ id: String) async throws -> DeletionJob { throw RepositoryFailure.readOnly }
}

/// Every call fails as if the network is down. Used to test cached reading and the edit outbox.
public actor OfflineServices: ClippyServices {
    public init() {}
    public func days(cursor: String?) async throws -> Days { throw RepositoryFailure.offline }
    public func day(_ id: String) async throws -> Day { throw RepositoryFailure.offline }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection { throw RepositoryFailure.offline }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction { throw RepositoryFailure.offline }
    public func captureImage(_ captureID: String) async throws -> Data { throw RepositoryFailure.offline }
    public func devices() async throws -> Devices { throw RepositoryFailure.offline }
    public func device(_ id: String) async throws -> DeviceDetail { throw RepositoryFailure.offline }
    public func configure(deviceID: String, configuration: Configuration, key: String) async throws -> DeviceDetail { throw RepositoryFailure.offline }
    public func requestSync(deviceID: String, key: String) async throws -> SyncRequest { throw RepositoryFailure.offline }
    public func sync(_ id: String) async throws -> SyncRequest { throw RepositoryFailure.offline }
    public func cancelSync(_ id: String, key: String) async throws -> SyncRequest { throw RepositoryFailure.offline }
    public func claim(_ input: ClaimInput, key: String) async throws -> Claim { throw RepositoryFailure.offline }
    public func confirm(claimID: String, proof: ClaimProof, key: String) async throws -> Claim { throw RepositoryFailure.offline }
    public func profile() async throws -> Profile { throw RepositoryFailure.offline }
    public func updatePreferences(_ preferences: Preferences, key: String) async throws -> Profile { throw RepositoryFailure.offline }
    public func deleteAccount(key: String) async throws -> DeletionJob { throw RepositoryFailure.offline }
    public func deleteDay(_ id: String, key: String) async throws -> DeletionJob { throw RepositoryFailure.offline }
    public func deleteCapture(_ id: String, key: String) async throws -> DeletionJob { throw RepositoryFailure.offline }
    public func deletionJob(_ id: String) async throws -> DeletionJob { throw RepositoryFailure.offline }
}
