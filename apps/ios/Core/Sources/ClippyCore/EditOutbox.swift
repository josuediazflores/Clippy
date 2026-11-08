import Foundation
import CryptoKit

/// One user edit waiting to reach the server. The operation ID is kept across retries and app restarts,
/// so a request whose response was lost replays idempotently instead of creating a duplicate.
public struct PendingEdit: Codable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case reflection, correction }
    public enum Status: Codable, Sendable, Equatable {
        case pending
        /// The record changed elsewhere. The user's text is kept until they choose.
        case conflict(currentRevision: Int?)
        /// Permanently rejected (for example the day was deleted).
        case rejected(code: String)
    }
    public var kind: Kind
    public var dayID: String
    /// Day ID for a reflection, moment ID for a correction.
    public var targetID: String
    public var recordID: String
    public var edit: EditInput
    public var status: Status
    public var attempts: Int
    public var id: String { recordID }
}

public enum EditRecordID {
    public static let reflection = "reflection_main"
    /// Stable per moment. Long moment IDs are hashed so the record ID stays within the 96-character `Id` limit.
    public static func correction(momentID: String) -> String {
        let suffix = momentID.count <= 85 ? momentID : SHA256.hash(data: Data(momentID.utf8)).map { String(format: "%02x", $0) }.joined()
        return "correction_" + suffix
    }
}

public struct FlushResult: Sendable, Equatable {
    public var saved: [String] = []
    public var conflicts: [String] = []
    public var rejected: [String] = []
    public var stoppedOffline = false
    public var needsSignIn = false
}

/// Durable FIFO of pending edits, one per record.
public actor EditOutbox {
    private let url: URL?
    private var items: [PendingEdit]

    public init(url: URL?) {
        self.url = url
        if let url, let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode([PendingEdit].self, from: data) { items = decoded }
        else { items = [] }
    }

    public func all() -> [PendingEdit] { items }
    public func pending(recordID: String) -> PendingEdit? { items.first { $0.recordID == recordID } }

    /// Queues text for a record. Unchanged text keeps the existing operation ID; new text gets a new one.
    @discardableResult
    public func enqueue(kind: PendingEdit.Kind, dayID: String, targetID: String, recordID: String, text: String, baseRevision: Int) throws -> PendingEdit {
        if let index = items.firstIndex(where: { $0.recordID == recordID }) {
            var item = items[index]
            if item.edit.text == text, item.status == .pending { return item }
            let base: Int
            if case .conflict(let current?) = item.status { base = current } else { base = item.edit.expectedRevision }
            item.edit = EditInput(schemaVersion: 1, operationId: OperationID.make(), expectedRevision: base, text: text, deleted: false)
            item.status = .pending
            item.attempts = 0
            items[index] = item
            try persist()
            return item
        }
        let item = PendingEdit(kind: kind, dayID: dayID, targetID: targetID, recordID: recordID,
                               edit: EditInput(schemaVersion: 1, operationId: OperationID.make(), expectedRevision: baseRevision, text: text, deleted: false),
                               status: .pending, attempts: 0)
        items.append(item)
        try persist()
        return item
    }

    /// Resolves a conflict by writing the user's text over the server's current revision, with a new operation ID.
    public func keepMine(recordID: String) throws {
        guard let index = items.firstIndex(where: { $0.recordID == recordID }), case .conflict(let current) = items[index].status else { return }
        items[index].edit = EditInput(schemaVersion: 1, operationId: OperationID.make(), expectedRevision: current ?? items[index].edit.expectedRevision, text: items[index].edit.text, deleted: false)
        items[index].status = .pending
        items[index].attempts = 0
        try persist()
    }

    public func discard(recordID: String) throws {
        items.removeAll { $0.recordID == recordID }
        try persist()
    }

    public func discardAll(dayID: String) throws {
        items.removeAll { $0.dayID == dayID }
        try persist()
    }

    public func clear() throws { items = []; try persist() }

    /// Sends pending edits in order. Stops at the first offline or sign-in failure so order is preserved.
    public func flush(using repository: any JournalRepository) async -> FlushResult {
        var result = FlushResult()
        for item in items where item.status == .pending {
            guard let index = items.firstIndex(where: { $0.recordID == item.recordID }) else { continue }
            items[index].attempts += 1
            do {
                switch item.kind {
                case .reflection: _ = try await repository.saveReflection(dayID: item.targetID, id: item.recordID, edit: item.edit)
                case .correction: _ = try await repository.saveCorrection(momentID: item.targetID, id: item.recordID, edit: item.edit)
                }
                // Only remove if the user has not replaced the text while the request was in flight.
                if let current = items.firstIndex(where: { $0.recordID == item.recordID }), items[current].edit.operationId == item.edit.operationId {
                    items.remove(at: current)
                }
                result.saved.append(item.recordID)
            } catch RepositoryFailure.offline {
                result.stoppedOffline = true; break
            } catch RepositoryFailure.unauthorized {
                result.needsSignIn = true; break
            } catch RepositoryFailure.server("REVISION_CONFLICT", let current) {
                mark(item, .conflict(currentRevision: current)); result.conflicts.append(item.recordID)
            } catch RepositoryFailure.server(let code, _) where ["DELETED", "NOT_FOUND", "INVALID_REQUEST", "FORBIDDEN"].contains(code) {
                mark(item, .rejected(code: code)); result.rejected.append(item.recordID)
            } catch {
                // Retryable server error: keep it pending with the same operation ID.
            }
        }
        try? persist()
        return result
    }

    private func mark(_ item: PendingEdit, _ status: PendingEdit.Status) {
        if let index = items.firstIndex(where: { $0.recordID == item.recordID && $0.edit.operationId == item.edit.operationId }) { items[index].status = status }
    }

    private func persist() throws {
        guard let url else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(items).write(to: url, options: [.atomic, .completeFileProtection])
    }
}

/// Decides what an editor shows after a refresh, so a regenerated recap never wipes the user's words.
public enum EditorText {
    public static func resolve(server: String?, pending: PendingEdit?, draft: String, dirty: Bool) -> String {
        if dirty { return draft }
        if let pending, !pending.isRejected { return pending.edit.text }
        return server ?? ""
    }
}

extension PendingEdit {
    public var isRejected: Bool { if case .rejected = status { true } else { false } }
    public var isConflict: Bool { if case .conflict = status { true } else { false } }
}
