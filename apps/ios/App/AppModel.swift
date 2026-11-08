import Foundation
import Observation
import ClippyCore

@MainActor @Observable
final class AppModel {
    enum SaveState: Equatable { case idle, saving, saved, queued, conflict, failed }

    private(set) var mode: AppMode?
    private(set) var services: (any ClippyServices)?
    private(set) var cognitoSession: CognitoAuthSession?
    var days: [Day] = []
    var devices: [DeviceIdentity] = []
    var pending: [PendingEdit] = []
    var offline = false
    var loading = false
    var needsSignIn = false
    var notice: String?

    let config: AppConfig
    /// Persistent only for real backends, and separate per mode so edits never cross between servers.
    private var store: JournalStore?
    private var outbox = EditOutbox(url: nil)
    private let support = URL.applicationSupportDirectory.appendingPathComponent("Clippy", isDirectory: true)

    init(config: AppConfig = .current) {
        self.config = config
        if config.resetOnLaunch { try? FileManager.default.removeItem(at: support) }
        if let forced = config.forcedMode { try? activate(forced) }
        else if let saved = UserDefaults.standard.string(forKey: "clippy.mode").flatMap(AppMode.init(rawValue:)), saved != .fixture { try? activate(saved) }
    }

    var readOnly: Bool { mode == .fixture }
    var latest: Day? { days.first }
    func day(_ id: String) -> Day? { days.first { $0.dayId == id } }

    // MARK: Session

    func activate(_ mode: AppMode) throws {
        let schema = try config.resource("schema"), transitions = try config.resource("transitions")
        switch mode {
        case .fixture:
            services = try FixtureServices(data: config.resource(config.fixtureName))
        case .demo:
            services = DemoServices(seed: DemoJournal.days())
        case .local:
            services = config.simulateOffline ? OfflineServices() : try HTTPClippyClient(baseURL: config.localBaseURL, auth: StaticBearer(token: config.localUser), schema: schema, transitions: transitions)
        case .cloud:
            guard let base = config.cloudBaseURL, let cognito = config.cognito else { throw RepositoryFailure.unavailable }
            let session = CognitoAuthSession(config: cognito, store: KeychainTokenStore())
            cognitoSession = session
            services = try HTTPClippyClient(baseURL: base, auth: session, schema: schema, transitions: transitions)
        }
        switch mode {
        case .local, .cloud:
            store = JournalStore(url: support.appendingPathComponent("journal-\(mode.rawValue)-v1.json"),
                                 legacyDayURL: mode == .local ? URL.documentsDirectory.appendingPathComponent("synthetic-day.json") : nil)
            outbox = EditOutbox(url: support.appendingPathComponent("outbox-\(mode.rawValue)-v1.json"))
        case .demo, .fixture:
            store = nil
            outbox = EditOutbox(url: nil)
        }
        self.mode = mode
        needsSignIn = false
        if mode != .fixture, config.forcedMode == nil { UserDefaults.standard.set(mode.rawValue, forKey: "clippy.mode") }
    }

    func signOut() async {
        await cognitoSession?.signOut()
        try? await store?.clear()
        try? await outbox.clear()
        UserDefaults.standard.removeObject(forKey: "clippy.mode")
        days = []; devices = []; pending = []; services = nil; cognitoSession = nil; mode = nil
    }

    // MARK: Journal

    func refresh() async {
        guard let services else { return }
        loading = true
        defer { loading = false }
        await flushEdits()
        do {
            let fetched = try await services.days(cursor: nil)
            days = fetched.items.sorted { $0.startAt > $1.startAt }
            offline = false
            try? await store?.replaceDays(days)
            devices = (try? await services.devices().items) ?? devices
        } catch RepositoryFailure.unauthorized {
            needsSignIn = true
        } catch {
            offline = true
            if let store { days = await store.read().days }
        }
        pending = await outbox.all()
    }

    func reload(dayID: String) async {
        guard let services else { return }
        do {
            let fresh = try await services.day(dayID)
            if let index = days.firstIndex(where: { $0.dayId == dayID }) { days[index] = fresh } else { days.insert(fresh, at: 0) }
            try? await store?.upsert(fresh)
        } catch RepositoryFailure.server("DELETED", _) {
            days.removeAll { $0.dayId == dayID }
            try? await store?.remove(dayID: dayID)
        } catch {}
    }

    private func flushEdits() async {
        guard let services, !readOnly else { return }
        let result = await outbox.flush(using: services)
        if result.needsSignIn { needsSignIn = true }
        pending = await outbox.all()
    }

    func pendingEdit(_ recordID: String, dayID: String) -> PendingEdit? {
        pending.first { $0.recordID == recordID && $0.dayID == dayID }
    }

    // MARK: Edits

    func saveReflection(day: Day, text: String) async -> SaveState {
        let base = day.reflections.first { $0.recordId == EditRecordID.reflection }?.revision ?? 0
        return await save(kind: .reflection, day: day, targetID: day.dayId, recordID: EditRecordID.reflection, text: text, base: base)
    }

    func saveCorrection(day: Day, moment: Moment, text: String) async -> SaveState {
        let recordID = EditRecordID.correction(momentID: moment.momentId)
        let base = day.corrections.first { $0.recordId == recordID }?.revision ?? 0
        return await save(kind: .correction, day: day, targetID: moment.momentId, recordID: recordID, text: text, base: base)
    }

    private func save(kind: PendingEdit.Kind, day: Day, targetID: String, recordID: String, text: String, base: Int) async -> SaveState {
        guard let services, !readOnly else { return .failed }
        do { try await outbox.enqueue(kind: kind, dayID: day.dayId, targetID: targetID, recordID: recordID, text: text, baseRevision: base) }
        catch { return .failed }
        let result = await outbox.flush(using: services)
        pending = await outbox.all()
        if result.needsSignIn { needsSignIn = true; return .queued }
        if result.saved.contains(recordID) { offline = false; await reload(dayID: day.dayId); return .saved }
        if result.conflicts.contains(recordID) { return .conflict }
        if result.rejected.contains(recordID) { return .failed }
        if result.stoppedOffline { offline = true }
        return .queued
    }

    /// The user keeps their text over a newer server revision.
    func keepMine(_ recordID: String, dayID: String) async {
        try? await outbox.keepMine(recordID: recordID)
        await flushEdits()
        await reload(dayID: dayID)
    }

    /// The user accepts the server's version and drops their queued text.
    func useTheirs(_ recordID: String, dayID: String) async {
        try? await outbox.discard(recordID: recordID)
        pending = await outbox.all()
        await reload(dayID: dayID)
    }

    // MARK: Deletion

    func deleteDay(_ day: Day) async -> String? {
        guard let services else { return nil }
        do {
            let job = try await services.deleteDay(day.dayId, key: OperationID.make())
            days.removeAll { $0.dayId == day.dayId }
            try? await store?.remove(dayID: day.dayId)
            try? await outbox.discardAll(dayID: day.dayId)
            pending = await outbox.all()
            return await settle(job)
        } catch { return failureText(error) }
    }

    func deleteCapture(_ captureID: String, dayID: String) async -> String? {
        guard let services else { return nil }
        do {
            let job = try await services.deleteCapture(captureID, key: OperationID.make())
            let label = await settle(job)
            await reload(dayID: dayID)
            return label
        } catch { return failureText(error) }
    }

    func deleteAccount() async -> String? {
        guard let services else { return nil }
        do {
            let job = try await services.deleteAccount(key: OperationID.make())
            let label = await settle(job)
            await signOut()
            return label
        } catch { return failureText(error) }
    }

    /// Polls a deletion job until it settles, for at most about ten seconds.
    private func settle(_ job: DeletionJob) async -> String {
        var current = job
        for _ in 0..<10 where !DeletionStatus.settled(current) {
            try? await Task.sleep(for: .seconds(1))
            if let next = try? await services?.deletionJob(job.jobId) { current = next }
        }
        return DeletionStatus.label(current)
    }

    func failureText(_ error: Error) -> String {
        switch error as? RepositoryFailure {
        case .offline: "Offline"
        case .unauthorized: "Sign in again"
        case .unavailable: "Not available yet"
        case .readOnly: "Preview only"
        case .server(let code, _): code == "REVISION_CONFLICT" ? "Changed elsewhere" : "Error: \(code)"
        case nil: "Something went wrong"
        }
    }
}
