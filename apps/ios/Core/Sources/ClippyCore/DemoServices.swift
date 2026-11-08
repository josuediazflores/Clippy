import Foundation

/// In-memory simulated backend and wearable. Lets the app demonstrate pairing, sync progress, configuration,
/// edits and deletion before P07 exists. It proves nothing about real AWS, BLE, or hardware behavior.
public actor DemoServices: ClippyServices {
    private var days: [Day]
    private var identities: [String: DeviceIdentity] = [:]
    private var states: [String: DeviceState] = [:]
    private var configurations: [String: Configuration] = [:]
    private var syncs: [String: (request: SyncRequest, started: Date, cancelled: Bool)] = [:]
    private var claims: [String: Claim] = [:]
    private var jobs: [String: DeletionJob] = [:]
    private var profileValue = Profile(schemaVersion: 1, journalTimeZone: "UTC", revision: 1, retentionDays: 30, consentRevision: 1)
    private let now: @Sendable () -> Date
    /// Seconds per sync step.
    private let stepSeconds: TimeInterval

    public init(seed: [Day], paired: Bool = true, stepSeconds: TimeInterval = 1.2, now: @escaping @Sendable () -> Date = { Date() }) {
        days = seed
        self.now = now
        self.stepSeconds = stepSeconds
        if paired {
            let device = DemoServices.makeDevice("dev_demo_001", battery: 78, at: Instants.string(now()))
            identities[device.0.deviceId] = device.0; states[device.0.deviceId] = device.1; configurations[device.0.deviceId] = device.2
        }
    }

    private func stamp() -> String { Instants.string(now()) }

    private static func makeDevice(_ id: String, battery: Int, at stamp: String) -> (DeviceIdentity, DeviceState, Configuration) {
        (DeviceIdentity(schemaVersion: 1, deviceId: id, ownershipEpoch: 1, protocolVersion: 1, firmwareVersion: "demo-1", claimState: "owned", configurationRevision: 1, appliedRevision: 1),
         DeviceState(schemaVersion: 1, deviceId: id, ownershipEpoch: 1, captureState: "capturing", batteryPercent: battery, charging: false, queuedCaptures: 14, queuedBytes: 14 * 380_000, connectivity: "online", clockQuality: "synchronized", appliedRevision: 1, observedAt: stamp),
         Configuration(schemaVersion: 1, expectedRevision: 1, captureIntervalSeconds: 600, pauseResumePolicy: "explicit", automaticSyncEnabled: true, nightlyLocalTime: "02:00", timeZone: "UTC", preferCharging: true))
    }

    private func addDevice(_ id: String, battery: Int) {
        let device = DemoServices.makeDevice(id, battery: battery, at: stamp())
        identities[id] = device.0; states[id] = device.1; configurations[id] = device.2
    }

    // MARK: Journal

    public func days(cursor: String?) async throws -> Days { Days(schemaVersion: 1, items: days.sorted { $0.startAt > $1.startAt }, nextCursor: nil) }
    public func day(_ id: String) async throws -> Day {
        guard let day = days.first(where: { $0.dayId == id }) else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        return day
    }

    public func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection {
        guard let index = days.firstIndex(where: { $0.dayId == dayID }) else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        let current = days[index].reflections.first { $0.recordId == id }
        if let current, current.operationId == edit.operationId { return current }
        guard (current?.revision ?? 0) == edit.expectedRevision else { throw RepositoryFailure.server("REVISION_CONFLICT", current?.revision ?? 0) }
        let saved = Reflection(schemaVersion: 1, operationId: edit.operationId, recordId: id, dayId: dayID, revision: edit.expectedRevision + 1, text: edit.text, deleted: edit.deleted, updatedAt: stamp())
        days[index].reflections.removeAll { $0.recordId == id }
        days[index].reflections.append(saved)
        return saved
    }

    public func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction {
        guard let index = days.firstIndex(where: { $0.recap?.moments.contains { $0.momentId == momentID } == true }) else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        let current = days[index].corrections.first { $0.recordId == id }
        if let current, current.operationId == edit.operationId { return current }
        guard (current?.revision ?? 0) == edit.expectedRevision else { throw RepositoryFailure.server("REVISION_CONFLICT", current?.revision ?? 0) }
        let saved = Correction(schemaVersion: 1, operationId: edit.operationId, recordId: id, dayId: days[index].dayId, revision: edit.expectedRevision + 1, text: edit.text, deleted: edit.deleted, updatedAt: stamp(), momentId: momentID)
        days[index].corrections.removeAll { $0.recordId == id }
        days[index].corrections.append(saved)
        return saved
    }

    public func captureImage(_ captureID: String) async throws -> Data { throw RepositoryFailure.unavailable }

    // MARK: Devices

    public func devices() async throws -> Devices { Devices(schemaVersion: 1, items: identities.values.sorted { $0.deviceId < $1.deviceId }, nextCursor: nil) }

    public func device(_ id: String) async throws -> DeviceDetail {
        guard let identity = identities[id] else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        let active = syncs.values.map { advanced($0) }.first { $0.deviceId == id && !SyncProgress($0.state).isFinished }
        if var state = states[id] { state.observedAt = stamp(); states[id] = state }
        return DeviceDetail(schemaVersion: 1, identity: identity, state: states[id], activeSync: active)
    }

    public func configure(deviceID: String, configuration: Configuration, key: String) async throws -> DeviceDetail {
        guard var identity = identities[deviceID] else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        guard configuration.expectedRevision == identity.configurationRevision else { throw RepositoryFailure.server("REVISION_CONFLICT", identity.configurationRevision) }
        identity.configurationRevision += 1
        identity.appliedRevision = identity.configurationRevision
        identities[deviceID] = identity
        var stored = configuration
        stored.expectedRevision = identity.configurationRevision
        configurations[deviceID] = stored
        states[deviceID]?.appliedRevision = identity.appliedRevision
        return try await device(deviceID)
    }

    /// Demo-only control mirroring the wearable's tilt gesture.
    public func setPaused(_ paused: Bool, deviceID: String) {
        states[deviceID]?.captureState = paused ? "paused" : "capturing"
    }

    // MARK: Sync

    private func advanced(_ entry: (request: SyncRequest, started: Date, cancelled: Bool)) -> SyncRequest {
        var request = entry.request
        if entry.cancelled { request.state = "cancelled"; return request }
        let step = Int(now().timeIntervalSince(entry.started) / stepSeconds)
        request.state = SyncProgress.steps[min(step, SyncProgress.steps.count - 1)]
        request.revision = min(step, SyncProgress.steps.count - 1) + 1
        return request
    }

    public func requestSync(deviceID: String, key: String) async throws -> SyncRequest {
        guard identities[deviceID] != nil else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        if let existing = syncs[key] { return advanced(existing) }
        if let active = syncs.values.map({ advanced($0) }).first(where: { $0.deviceId == deviceID && !SyncProgress($0.state).isFinished }) { return active }
        let request = SyncRequest(schemaVersion: 1, syncRequestId: "sync_" + key.suffix(24).lowercased().filter { $0.isLetter || $0.isNumber }, deviceId: deviceID, ownershipEpoch: 1, trigger: "manual", state: "waiting_for_device", revision: 1, createdAt: stamp(), expiresAt: Instants.string(now().addingTimeInterval(300)))
        syncs[key] = (request, now(), false)
        return request
    }

    public func sync(_ id: String) async throws -> SyncRequest {
        guard let entry = syncs.values.first(where: { $0.request.syncRequestId == id }) else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        let request = advanced(entry)
        if request.state == "uploaded" { states[request.deviceId]?.queuedCaptures = 0; states[request.deviceId]?.queuedBytes = 0 }
        return request
    }

    public func cancelSync(_ id: String, key: String) async throws -> SyncRequest {
        guard let key = syncs.first(where: { $0.value.request.syncRequestId == id })?.key else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        if advanced(syncs[key]!).state != "uploaded" { syncs[key]!.cancelled = true }
        return advanced(syncs[key]!)
    }

    // MARK: Pairing

    public func claim(_ input: ClaimInput, key: String) async throws -> Claim {
        if let existing = claims.values.first(where: { $0.deviceId == input.deviceId && $0.state == "pending" }) { return existing }
        if identities[input.deviceId] != nil { throw RepositoryFailure.server("CONFLICT", nil) }
        let claim = Claim(schemaVersion: 1, claimId: "claim_" + input.challengeId.suffix(40), deviceId: input.deviceId, state: "pending", expiresAt: Instants.string(now().addingTimeInterval(600)))
        claims[claim.claimId] = claim
        return claim
    }

    public func confirm(claimID: String, proof: ClaimProof, key: String) async throws -> Claim {
        guard var claim = claims[claimID] else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        guard proof.proofHandle.count == 6, proof.proofHandle.allSatisfy(\.isNumber) else { throw RepositoryFailure.server("PRECONDITION_FAILED", nil) }
        claim.state = "confirmed"
        claims[claimID] = claim
        addDevice(claim.deviceId, battery: 100)
        return claim
    }

    // MARK: Account

    public func profile() async throws -> Profile { profileValue }

    public func updatePreferences(_ preferences: Preferences, key: String) async throws -> Profile {
        guard preferences.expectedRevision == profileValue.revision else { throw RepositoryFailure.server("REVISION_CONFLICT", profileValue.revision) }
        profileValue = Profile(schemaVersion: 1, journalTimeZone: preferences.journalTimeZone, revision: profileValue.revision + 1, retentionDays: preferences.retentionDays, consentRevision: profileValue.consentRevision)
        return profileValue
    }

    private func job(_ target: String) -> DeletionJob {
        let job = DeletionJob(schemaVersion: 1, jobId: "del_" + target.suffix(40), targetId: target, state: identities.isEmpty ? "complete" : "waiting_for_clients", revision: 4, cloudComplete: true, pendingDeviceIds: identities.keys.sorted())
        jobs[job.jobId] = job
        return job
    }

    public func deleteAccount(key: String) async throws -> DeletionJob {
        let result = job("account_demo")
        days = []; identities = [:]; states = [:]; configurations = [:]; syncs = [:]
        return result
    }

    public func deleteDay(_ id: String, key: String) async throws -> DeletionJob {
        days.removeAll { $0.dayId == id }
        return job(id)
    }

    public func deleteCapture(_ id: String, key: String) async throws -> DeletionJob {
        for index in days.indices {
            days[index].recap?.moments.removeAll { $0.evidence.contains { $0.type == "capture" && $0.id == id } }
            if let recap = days[index].recap {
                days[index].recap?.coverage.captured = recap.moments.count
                days[index].recap?.coverage.observed = recap.moments.count
            }
        }
        return job(id)
    }

    public func deletionJob(_ id: String) async throws -> DeletionJob {
        guard let job = jobs[id] else { throw RepositoryFailure.server("NOT_FOUND", nil) }
        return job
    }
}
