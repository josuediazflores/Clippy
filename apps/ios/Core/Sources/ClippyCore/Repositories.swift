import Foundation

public enum RepositoryFailure: Error, Sendable {
    case server(String, Int?)
    case offline
    case readOnly
}
public actor HTTPJournalRepository: JournalRepository, DeviceService, SyncService {
    private let baseURL: URL
    private let validator: ContractValidator
    private let session: URLSession
    public init(baseURL: URL, schema: Data, transitions: Data) throws {
        guard baseURL.scheme == "http", baseURL.host == "127.0.0.1" else { throw RepositoryFailure.server("LOCAL_ONLY", nil) }
        self.baseURL = baseURL
        validator = try ContractValidator(schema: schema, transitions: transitions)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        session = URLSession(configuration: configuration)
    }
    private func request<T: Decodable & Sendable>(_ type: T.Type, kind: String, path: String, method: String = "GET", body: Data? = nil, key: String? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer local-user-a", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RepositoryFailure.offline }
        guard (200...299).contains(http.statusCode) else {
            let error = try validator.decode(APIError.self, kind: "Error", data: data)
            throw RepositoryFailure.server(error.error.code, error.error.currentRevision)
        }
        return try validator.decode(type, kind: kind, data: data)
    }
    public func day(_ id: String) async throws -> Day { try await request(Day.self, kind: "Day", path: "v1/days/\(id)") }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection {
        try await request(Reflection.self, kind: "Reflection", path: "v1/days/\(dayID)/reflections/\(id)", method: "PUT", body: JSONEncoder().encode(edit), key: edit.operationId)
    }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction {
        try await request(Correction.self, kind: "Correction", path: "v1/moments/\(momentID)/corrections/\(id)", method: "PUT", body: JSONEncoder().encode(edit), key: edit.operationId)
    }
    public func device(_ id: String) async throws -> DeviceDetail { try await request(DeviceDetail.self, kind: "DeviceDetail", path: "v1/devices/\(id)") }
    public func requestSync(deviceID: String, key: String) async throws -> SyncRequest {
        try await request(SyncRequest.self, kind: "SyncRequest", path: "v1/devices/\(deviceID)/sync-requests", method: "POST", body: JSONEncoder().encode(SyncRequestInput(schemaVersion: 1, trigger: "manual")), key: key)
    }
}
public actor FixtureJournalRepository: JournalRepository {
    private let value: Day
    public init(data: Data) throws { value = try JSONDecoder().decode(Day.self, from: data) }
    public func day(_ id: String) async throws -> Day { value }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection { throw RepositoryFailure.readOnly }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction { throw RepositoryFailure.readOnly }
}
public actor OfflineJournalRepository: JournalRepository {
    public init() {}
    public func day(_ id: String) async throws -> Day { throw RepositoryFailure.offline }
    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection { throw RepositoryFailure.offline }
    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction { throw RepositoryFailure.offline }
}
public actor DayCache {
    private let url: URL
    public init(url: URL) { self.url = url }
    public func read() -> Day? { guard let data = try? Data(contentsOf: url) else { return nil }; return try? JSONDecoder().decode(Day.self, from: data) }
    public func write(_ day: Day) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(day).write(to: url, options: .atomic)
    }
    public func remove() throws { if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) } }
}
