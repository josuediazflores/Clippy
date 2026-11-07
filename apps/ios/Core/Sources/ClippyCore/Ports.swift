import Foundation

public protocol JournalRepository: Sendable {
    func day(_ id: String) async throws -> Day
    func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection
    func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction
}
public protocol AuthSession: Sendable { func authorization() async throws -> String }
public protocol DeviceService: Sendable { func device(_ id: String) async throws -> DeviceDetail }
public protocol SyncService: Sendable { func requestSync(deviceID: String, key: String) async throws -> SyncRequest }
public protocol CalendarSource: Sendable { func snapshot() async throws -> CalendarBundle? }
