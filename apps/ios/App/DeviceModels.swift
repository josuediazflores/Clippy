import Foundation
import Observation
import ClippyCore

/// Editable device settings. The API has no read route for configuration, so the last sent values are kept locally.
struct ConfigDraft: Codable, Equatable {
    var intervalMinutes = 10
    var automaticSync = true
    var nightlyTime = "02:00"
    var chargingOnly = true

    static func load(_ deviceID: String) -> ConfigDraft {
        UserDefaults.standard.data(forKey: "clippy.config.\(deviceID)").flatMap { try? JSONDecoder().decode(ConfigDraft.self, from: $0) } ?? ConfigDraft()
    }
    func store(_ deviceID: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: "clippy.config.\(deviceID)")
    }
    func wire(revision: Int, timeZone: String) -> Configuration {
        Configuration(schemaVersion: 1, expectedRevision: revision, captureIntervalSeconds: intervalMinutes * 60, pauseResumePolicy: "explicit",
                      automaticSyncEnabled: automaticSync, nightlyLocalTime: automaticSync ? nightlyTime : nil, timeZone: timeZone, preferCharging: chargingOnly)
    }
}

@MainActor @Observable
final class DeviceModel {
    var detail: DeviceDetail?
    var sync: SyncRequest?
    var draft = ConfigDraft()
    var savedDraft = ConfigDraft()
    var status: String?
    var busy = false
    private var poll: Task<Void, Never>?

    var syncProgress: SyncProgress? { sync.map { SyncProgress($0.state) } }
    var configApplied: Bool { detail.map { $0.identity.appliedRevision >= $0.identity.configurationRevision } ?? false }
    var configDirty: Bool { draft != savedDraft }

    func load(_ deviceID: String, services: any ClippyServices) async {
        do {
            let detail = try await services.device(deviceID)
            self.detail = detail
            if let active = detail.activeSync, sync == nil || sync?.syncRequestId == active.syncRequestId { sync = active; startPolling(services) }
            if draft == savedDraft { savedDraft = ConfigDraft.load(deviceID); draft = savedDraft }
        } catch { status = message(error) }
    }

    func syncNow(services: any ClippyServices) async {
        guard let id = detail?.identity.deviceId else { return }
        busy = true; defer { busy = false }
        do { sync = try await services.requestSync(deviceID: id, key: OperationID.make()); status = nil; startPolling(services) }
        catch { status = message(error) }
    }

    func cancelSync(services: any ClippyServices) async {
        guard let id = sync?.syncRequestId else { return }
        do { sync = try await services.cancelSync(id, key: OperationID.make()) } catch { status = message(error) }
    }

    /// Bounded polling: stops when the request settles, expires, or after two minutes.
    private func startPolling(_ services: any ClippyServices) {
        poll?.cancel()
        poll = Task { [weak self] in
            for _ in 0..<100 {
                try? await Task.sleep(for: .milliseconds(1200))
                guard let self, !Task.isCancelled, let id = self.sync?.syncRequestId else { return }
                if let next = try? await services.sync(id) { self.sync = next }
                if self.syncProgress?.isFinished ?? true { await self.load(next: services); return }
                if let expiry = Instants.date(self.sync?.expiresAt), expiry < Date() { return }
            }
        }
    }

    private func load(next services: any ClippyServices) async {
        if let id = detail?.identity.deviceId { detail = try? await services.device(id) }
    }

    func saveConfig(services: any ClippyServices, timeZone: String) async {
        guard let identity = detail?.identity else { return }
        busy = true; defer { busy = false }
        do {
            detail = try await services.configure(deviceID: identity.deviceId, configuration: draft.wire(revision: identity.configurationRevision, timeZone: timeZone), key: OperationID.make())
            draft.store(identity.deviceId); savedDraft = draft; status = nil
        } catch { status = message(error) }
    }

    func stop() { poll?.cancel() }

    private func message(_ error: Error) -> String {
        switch error as? RepositoryFailure {
        case .offline: "Offline"
        case .unavailable: "Not available yet"
        case .unauthorized: "Sign in again"
        case .server("REVISION_CONFLICT", _): "Changed elsewhere"
        case .server(let code, _): code.replacingOccurrences(of: "_", with: " ").capitalized
        default: "Error"
        }
    }
}

@MainActor @Observable
final class PairingModel {
    enum Step: Equatable { case scan, claiming, code(claimID: String), confirming, done(String), failed(String) }
    var step: Step = .scan
    var code = ""

    func scanned(_ text: String, services: any ClippyServices) async {
        guard case .scan = step else { return }
        guard let pairing = PairingCode(text) else { step = .failed("Not a Clippy code"); return }
        step = .claiming
        do {
            // A printed QR carries a one-time secret, so the server can confirm immediately (D50).
            // A pending claim still asks for the device's code (screen-based hardware, D42).
            let claim = try await services.claim(pairing.claimInput, key: OperationID.make())
            step = claim.state == "confirmed" ? .done(claim.deviceId) : .code(claimID: claim.claimId)
        }
        catch { step = .failed(Self.text(error)) }
    }

    func confirm(services: any ClippyServices) async {
        guard case .code(let claimID) = step else { return }
        step = .confirming
        do {
            let result = try await services.confirm(claimID: claimID, proof: ClaimProof(schemaVersion: 1, proofHandle: code), key: OperationID.make())
            step = result.state == "confirmed" ? .done(result.deviceId) : .failed(result.state == "expired" ? "Code expired" : "Not confirmed")
        } catch { step = .code(claimID: claimID); code = ""; failedCode = Self.text(error) }
    }

    var failedCode: String?

    func reset() { step = .scan; code = ""; failedCode = nil }

    static func text(_ error: Error) -> String {
        switch error as? RepositoryFailure {
        case .unavailable: "Pairing isn't live yet"
        case .offline: "Offline"
        case .server("CONFLICT", _): "Already paired"
        case .server("EXPIRED", _): "Code expired"
        case .server("PRECONDITION_FAILED", _): "Wrong code"
        default: "Couldn't pair"
        }
    }
}
