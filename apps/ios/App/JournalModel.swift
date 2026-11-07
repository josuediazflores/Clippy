import Foundation
import CryptoKit
import Observation
import ClippyCore

@MainActor @Observable
final class JournalModel {
    var day: Day?
    var device: DeviceDetail?
    var offline = false
    var loading = false
    var saving = false
    var message: String?
    var reflectionDraft = ""
    let preview: Bool
    private let repository: any JournalRepository
    private let services: HTTPJournalRepository?
    private let cache: DayCache
    private var pendingReflection: EditInput?
    private var pendingCorrection: EditInput?

    init(repository: any JournalRepository, services: HTTPJournalRepository?, cache: DayCache, preview: Bool) {
        self.repository = repository; self.services = services; self.cache = cache; self.preview = preview
    }
    var state: String { offline ? "offline" : day?.state ?? (loading ? "pending" : "empty") }
    var label: String {
        switch state {
        case "pending": "Preparing your recap"
        case "partial": "Some moments are missing"
        case "ready": "Recap ready"
        case "failure": "Recap couldn't finish"
        case "offline": "You're offline"
        default: "No moments yet"
        }
    }
    var explanation: String {
        switch state {
        case "pending": "The snapshot is uploaded. Observations and your recap are still being prepared."
        case "partial": "Available moments are shown below. Missing observations aren't treated as a complete day."
        case "ready": "This recap covers the uploaded snapshot. Later captures can update the same day."
        case "failure": "Your captures are retained. A local processing attempt failed; your saved edits are safe."
        case "offline": day == nil ? "Connect to the local server to load your first recap." : "Reading your saved recap. Reconnect before saving changes or requesting a sync."
        default: "Your first verified snapshot will appear here. The device simulator uses synthetic images."
        }
    }
    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await repository.day("day_20261107")
            day = loaded; offline = false
            reflectionDraft = loaded.reflections.first(where: { !$0.deleted })?.text ?? ""
            if !preview { try await cache.write(loaded) }
            if let services { device = try? await services.device("dev_sample_001") }
        } catch RepositoryFailure.server("DELETED", _) {
            try? await cache.remove(); day = nil; offline = false; message = "This day was deleted. Its saved copy has been removed."
        } catch {
            if !preview { day = await cache.read() }
            offline = true
            reflectionDraft = day?.reflections.first(where: { !$0.deleted })?.text ?? ""
        }
    }
    private func operationID() -> String { "op_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    func saveReflection() async {
        guard let day, !offline, !preview else { return }
        saving = true; defer { saving = false }
        let existing = day.reflections.first { $0.recordId == "reflection_main" }
        if pendingReflection?.text != reflectionDraft {
            pendingReflection = EditInput(schemaVersion: 1, operationId: operationID(), expectedRevision: existing?.revision ?? 0, text: reflectionDraft, deleted: false)
        }
        do {
            _ = try await repository.saveReflection(dayID: day.dayId, id: "reflection_main", edit: pendingReflection!)
            pendingReflection = nil; await refresh(); message = "Reflection saved"
        } catch RepositoryFailure.server("REVISION_CONFLICT", _) {
            pendingReflection = nil; message = "This reflection changed elsewhere. Your draft is still here. Refresh before trying again."
        } catch { message = "Couldn't save. Your draft is still here; retry when connected." }
    }
    func saveCorrection(moment: Moment, text: String) async -> Bool {
        guard let day, !offline, !preview else { return false }
        saving = true; defer { saving = false }
        let suffix = moment.momentId.count <= 85 ? moment.momentId : SHA256.hash(data: Data(moment.momentId.utf8)).map { String(format: "%02x", $0) }.joined()
        let id = "correction_" + suffix
        let existing = day.corrections.first { $0.recordId == id }
        if pendingCorrection?.text != text {
            pendingCorrection = EditInput(schemaVersion: 1, operationId: operationID(), expectedRevision: existing?.revision ?? 0, text: text, deleted: false)
        }
        do {
            _ = try await repository.saveCorrection(momentID: moment.momentId, id: id, edit: pendingCorrection!)
            pendingCorrection = nil; await refresh(); message = "Correction saved. The next recap will use your wording."; return true
        } catch RepositoryFailure.server("REVISION_CONFLICT", _) {
            pendingCorrection = nil; message = "This moment changed elsewhere. Refresh before trying again."; return false
        } catch { message = "Couldn't save this correction. Try again when connected."; return false }
    }
    func syncNow() async {
        guard let services, !offline else { return }
        do {
            let request = try await services.requestSync(deviceID: "dev_sample_001", key: operationID())
            message = request.state == "waiting_for_device" ? "Sync requested. Waiting for the simulated device." : "A sync is already in progress."
        } catch { message = "Couldn't request sync. Check the local connection." }
    }
}
