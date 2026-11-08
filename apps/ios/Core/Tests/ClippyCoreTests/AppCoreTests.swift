import XCTest
@testable import ClippyCore

/// Repository double that records calls and fails on demand.
actor ScriptedJournal: JournalRepository {
    var failures: [RepositoryFailure] = []
    var calls: [(String, EditInput)] = []
    func fail(_ list: [RepositoryFailure]) { failures = list }
    private func next(_ id: String, _ edit: EditInput) throws {
        calls.append((id, edit))
        if !failures.isEmpty { throw failures.removeFirst() }
    }
    func days(cursor: String?) async throws -> Days { Days(schemaVersion: 1, items: [], nextCursor: nil) }
    func day(_ id: String) async throws -> Day { throw RepositoryFailure.offline }
    func saveReflection(dayID: String, id: String, edit: EditInput) async throws -> Reflection {
        try next(id, edit)
        return Reflection(schemaVersion: 1, operationId: edit.operationId, recordId: id, dayId: dayID, revision: edit.expectedRevision + 1, text: edit.text, deleted: false, updatedAt: "2026-11-07T20:00:00Z")
    }
    func saveCorrection(momentID: String, id: String, edit: EditInput) async throws -> Correction {
        try next(id, edit)
        return Correction(schemaVersion: 1, operationId: edit.operationId, recordId: id, dayId: "day_20261107", revision: edit.expectedRevision + 1, text: edit.text, deleted: false, updatedAt: "2026-11-07T20:00:00Z", momentId: momentID)
    }
    func captureImage(_ captureID: String) async throws -> Data { Data() }
}

/// Scratch space inside the package's ignored `.build` directory, removed by `swift package clean`.
func testScratch(_ name: String) -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent(".build/clippy-tests/\(UUID().uuidString)").appendingPathComponent(name)
}

final class EditOutboxTests: XCTestCase {
    private func temp(_ name: String) -> URL { testScratch(name) }

    func testOfflineEditSurvivesRestartAndReplaysWithSameOperationID() async throws {
        let url = temp("outbox.json")
        let first = EditOutbox(url: url)
        let queued = try await first.enqueue(kind: .reflection, dayID: "day_20261107", targetID: "day_20261107", recordID: "reflection_main", text: "Offline words", baseRevision: 1)
        let repository = ScriptedJournal()
        await repository.fail([.offline])
        let offline = await first.flush(using: repository)
        XCTAssertTrue(offline.stoppedOffline)

        let restarted = EditOutbox(url: url)
        let pending = await restarted.all()
        XCTAssertEqual(pending.first?.edit.operationId, queued.edit.operationId)
        let online = await restarted.flush(using: repository)
        XCTAssertEqual(online.saved, ["reflection_main"])
        let calls = await repository.calls
        XCTAssertEqual(calls.map(\.1.operationId), [queued.edit.operationId, queued.edit.operationId], "retry must reuse the operation ID")
        let remaining = await restarted.all()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testUnchangedTextKeepsOperationIDAndChangedTextReplacesIt() async throws {
        let outbox = EditOutbox(url: nil)
        let a = try await outbox.enqueue(kind: .reflection, dayID: "d", targetID: "day_x", recordID: "reflection_main", text: "One", baseRevision: 0)
        let b = try await outbox.enqueue(kind: .reflection, dayID: "d", targetID: "day_x", recordID: "reflection_main", text: "One", baseRevision: 0)
        let c = try await outbox.enqueue(kind: .reflection, dayID: "d", targetID: "day_x", recordID: "reflection_main", text: "Two", baseRevision: 0)
        XCTAssertEqual(a.edit.operationId, b.edit.operationId)
        XCTAssertNotEqual(a.edit.operationId, c.edit.operationId)
        XCTAssertEqual(c.edit.expectedRevision, 0)
        let count = await outbox.all().count
        XCTAssertEqual(count, 1)
    }

    func testConflictKeepsUserTextUntilTheyChoose() async throws {
        let outbox = EditOutbox(url: nil)
        _ = try await outbox.enqueue(kind: .correction, dayID: "day_20261107", targetID: "moment_cap_sample_001", recordID: "correction_moment_cap_sample_001", text: "Mine", baseRevision: 1)
        let repository = ScriptedJournal()
        await repository.fail([.server("REVISION_CONFLICT", 3)])
        let result = await outbox.flush(using: repository)
        XCTAssertEqual(result.conflicts, ["correction_moment_cap_sample_001"])
        let conflicted = await outbox.pending(recordID: "correction_moment_cap_sample_001")
        XCTAssertEqual(conflicted?.status, .conflict(currentRevision: 3))
        XCTAssertEqual(conflicted?.edit.text, "Mine")

        // A second flush must not overwrite the newer server revision on its own.
        _ = await outbox.flush(using: repository)
        let callsBefore = await repository.calls.count
        XCTAssertEqual(callsBefore, 1)

        try await outbox.keepMine(recordID: "correction_moment_cap_sample_001")
        let rebased = await outbox.pending(recordID: "correction_moment_cap_sample_001")
        XCTAssertEqual(rebased?.edit.expectedRevision, 3)
        XCTAssertNotEqual(rebased?.edit.operationId, conflicted?.edit.operationId)
        let saved = await outbox.flush(using: repository)
        XCTAssertEqual(saved.saved, ["correction_moment_cap_sample_001"])
    }

    func testDeletedTargetIsRejectedAndExpiredLoginStopsFlush() async throws {
        let outbox = EditOutbox(url: nil)
        _ = try await outbox.enqueue(kind: .reflection, dayID: "day_a", targetID: "day_a", recordID: "reflection_main", text: "A", baseRevision: 0)
        let repository = ScriptedJournal()
        await repository.fail([.server("DELETED", nil)])
        let rejected = await outbox.flush(using: repository)
        XCTAssertEqual(rejected.rejected, ["reflection_main"])

        let second = EditOutbox(url: nil)
        _ = try await second.enqueue(kind: .reflection, dayID: "day_b", targetID: "day_b", recordID: "reflection_main", text: "B", baseRevision: 0)
        _ = try await second.enqueue(kind: .correction, dayID: "day_b", targetID: "moment_x", recordID: "correction_moment_x", text: "C", baseRevision: 0)
        await repository.fail([.unauthorized])
        let expired = await second.flush(using: repository)
        XCTAssertTrue(expired.needsSignIn)
        let left = await second.all().count
        XCTAssertEqual(left, 2, "nothing is dropped when sign-in expires")
    }

    func testRegeneratedRecapDoesNotReplaceDraftOrPendingText() {
        XCTAssertEqual(EditorText.resolve(server: "Server", pending: nil, draft: "Typing", dirty: true), "Typing")
        let pending = PendingEdit(kind: .reflection, dayID: "d", targetID: "day_x", recordID: "reflection_main", edit: EditInput(schemaVersion: 1, operationId: "op_abc", expectedRevision: 1, text: "Queued", deleted: false), status: .pending, attempts: 0)
        XCTAssertEqual(EditorText.resolve(server: "Server", pending: pending, draft: "", dirty: false), "Queued")
        XCTAssertEqual(EditorText.resolve(server: "Server", pending: nil, draft: "", dirty: false), "Server")
    }

    func testLongMomentIDsProduceValidRecordIDs() {
        let long = "moment_" + String(repeating: "a", count: 89)
        let id = EditRecordID.correction(momentID: long)
        XCTAssertTrue(PairingCode.isID(id))
        XCTAssertEqual(EditRecordID.correction(momentID: "moment_cap_sample_001"), "correction_moment_cap_sample_001")
    }
}

final class JournalStoreTests: XCTestCase {
    private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }

    func testImportsP03CacheOnceAndKeepsDaysNewestFirst() async throws {
        let directory = testScratch("store")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = directory.appendingPathComponent("synthetic-day.json")
        try Data(contentsOf: root.appendingPathComponent("fixtures/ui/ready.json")).write(to: legacy)
        let store = JournalStore(url: directory.appendingPathComponent("journal.json"), legacyDayURL: legacy)
        let day = await store.day("day_20261107")
        XCTAssertEqual(day?.state, "ready")
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))

        var older = try XCTUnwrap(day)
        older.dayId = "day_20261106"; older.startAt = "2026-11-06T00:00:00Z"
        try await store.upsert(older)
        let reopened = JournalStore(url: directory.appendingPathComponent("journal.json"))
        let ids = await reopened.read().days.map(\.dayId)
        XCTAssertEqual(ids, ["day_20261107", "day_20261106"])
    }

    func testUnknownFutureFormatIsIgnoredNotMisread() async throws {
        let url = testScratch("future.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"format": 99, "days": [], "deviceIDs": []}"#.utf8).write(to: url)
        let store = JournalStore(url: url)
        let format = await store.read().format
        XCTAssertEqual(format, CachedJournal.currentFormat)
    }
}

final class PresenterTests: XCTestCase {
    func testPairingCodeAcceptsOnlyVersionedClippyPayloads() {
        let code = PairingCode("clippy://pair?v=1&d=dev_sample_003&c=chl_9f2a1b")
        XCTAssertEqual(code?.deviceID, "dev_sample_003")
        XCTAssertEqual(code?.claimInput.challengeId, "chl_9f2a1b")
        XCTAssertNil(PairingCode("https://example.com/pair?v=1&d=dev_x01&c=chl_x01"))
        XCTAssertNil(PairingCode("clippy://pair?v=2&d=dev_x01&c=chl_x01"))
        XCTAssertNil(PairingCode("clippy://pair?v=1&d=DEV-1&c=chl_x01"), "IDs must match the contract pattern")
        XCTAssertNil(PairingCode("clippy://pair?v=1&d=dev_x01"))
    }

    func testSyncProgressStepsAndBranches() {
        XCTAssertEqual(SyncProgress("uploaded").fraction, 1)
        XCTAssertTrue(SyncProgress("uploaded").isFinished)
        XCTAssertFalse(SyncProgress("uploaded").canCancel)
        XCTAssertTrue(SyncProgress("uploading").canCancel)
        XCTAssertTrue(SyncProgress("waiting_for_power").isProblem)
        XCTAssertLessThan(SyncProgress("preparing").fraction, SyncProgress("verifying").fraction)
    }

    func testStaleBatteryIsMarkedAsLastKnown() throws {
        let state = DeviceState(schemaVersion: 1, deviceId: "dev_sample_001", ownershipEpoch: 1, captureState: "paused", batteryPercent: 62, charging: false, queuedCaptures: 3, queuedBytes: 100, connectivity: "online", clockQuality: "synchronized", appliedRevision: 1, observedAt: "2026-11-07T08:00:00Z")
        let fresh = DeviceStatus(state, now: try XCTUnwrap(Instants.date("2026-11-07T08:10:00Z")))
        let stale = DeviceStatus(state, now: try XCTUnwrap(Instants.date("2026-11-07T12:00:00Z")))
        XCTAssertFalse(fresh.isStale)
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.battery, "62%")
        XCTAssertEqual(stale.capture, "Paused")
        XCTAssertTrue(DeviceStatus(nil).isStale)
        XCTAssertEqual(DeviceStatus(nil).battery, "--")
    }

    func testClockUsesJournalTimeZone() {
        XCTAssertEqual(Instants.string(Instants.date("2026-11-07T09:40:00Z")!), "2026-11-07T09:40:00Z")
        XCTAssertNotEqual(Instants.clock("2026-11-07T09:40:00Z", zone: "UTC"), Instants.clock("2026-11-07T09:40:00Z", zone: "Asia/Tokyo"))
    }

    func testHTTPAllowsOnlyLoopbackPlaintext() {
        XCTAssertTrue(HTTPClippyClient.isAllowed(URL(string: "http://127.0.0.1:8787")!))
        XCTAssertTrue(HTTPClippyClient.isAllowed(URL(string: "https://api.example.com")!))
        XCTAssertFalse(HTTPClippyClient.isAllowed(URL(string: "http://api.example.com")!))
        XCTAssertFalse(HTTPClippyClient.isAllowed(URL(string: "ftp://127.0.0.1")!))
    }
}

final class AuthTests: XCTestCase {
    func testPKCEMatchesRFC7636Vector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "s1")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let config = CognitoConfiguration(domain: URL(string: "https://auth.example.com")!, clientID: "client123")
        let items = URLComponents(url: pkce.authorizeURL(config), resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertEqual(items.first { $0.name == "redirect_uri" }?.value, "clippy://auth/callback")
        XCTAssertNil(items.first { $0.name == "client_secret" })
        let signUp = URLComponents(url: pkce.authorizeURL(config, signUp: true), resolvingAgainstBaseURL: false)!
        XCTAssertEqual(signUp.path, "/signup")
        XCTAssertEqual(signUp.queryItems?.first { $0.name == "code_challenge" }?.value, pkce.challenge)
    }

    func testCallbackRejectsWrongStateOrError() throws {
        let pkce = PKCE(verifier: "v", state: "expected")
        XCTAssertEqual(try pkce.code(from: URL(string: "clippy://auth/callback?code=abc&state=expected")!), "abc")
        XCTAssertThrowsError(try pkce.code(from: URL(string: "clippy://auth/callback?code=abc&state=other")!))
        XCTAssertThrowsError(try pkce.code(from: URL(string: "clippy://auth/callback?error=access_denied&state=expected")!))
    }

    func testExpiredTokenRefreshesAndFailedRefreshRequiresSignIn() async throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let config = CognitoConfiguration(domain: URL(string: "https://auth.example.com")!, clientID: "client123")
        let store = MemoryTokenStore(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: now.addingTimeInterval(10)))
        let ok = CognitoAuthSession(config: config, store: store, transport: { request in
            let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
            XCTAssertTrue(body.contains("grant_type=refresh_token"))
            return (Data(#"{"access_token":"new","expires_in":3600}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, now: { now })
        let token = try await ok.authorization()
        XCTAssertEqual(token, "new")
        let kept = await store.load()?.refreshToken
        XCTAssertEqual(kept, "r1", "refresh token is kept when the response omits it")

        let expiredStore = MemoryTokenStore(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: now))
        let denied = CognitoAuthSession(config: config, store: expiredStore, transport: { request in
            (Data(#"{"error":"invalid_grant"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!)
        }, now: { now })
        do { _ = try await denied.authorization(); XCTFail("expected sign-in") }
        catch { XCTAssertEqual(error as? RepositoryFailure, .unauthorized) }
        let cleared = await expiredStore.load()
        XCTAssertNil(cleared)
    }
}

final class DemoJournalTests: XCTestCase {
    private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }

    func testDemoDaysAreValidAndTodayRunsFromAfternoonToNight() throws {
        let validator = try ContractValidator(schema: Data(contentsOf: root.appendingPathComponent("contracts/schema.json")),
                                              transitions: Data(contentsOf: root.appendingPathComponent("contracts/transitions.json")))
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        let now = try XCTUnwrap(Instants.date("2026-11-08T02:30:00Z")) // 6:30 PM Pacific, Nov 7
        let days = DemoJournal.days(now: now, zone: zone)
        XCTAssertEqual(days.map(\.dayId), ["day_20261107", "day_20261106", "day_20261105"])
        for day in days {
            // Swift's synthesized Codable omits nil optionals; the schema wants failureCode present as null.
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(day)) as? [String: Any])
            json["failureCode"] = json["failureCode"] ?? NSNull()
            XCTAssertNoThrow(try validator.validate("Day", data: JSONSerialization.data(withJSONObject: json)), day.dayId)
        }
        let today = days[0]
        XCTAssertEqual(today.timeZone, "America/Los_Angeles")
        XCTAssertEqual(today.startAt, "2026-11-07T08:00:00Z")
        let times = today.recap!.moments.map { Instants.clock($0.capturedAt, zone: today.timeZone) }
        XCTAssertEqual(times.first?.replacingOccurrences(of: "\u{202F}", with: " "), "3:04 PM")
        XCTAssertEqual(today.recap?.moments.last?.title, "Lights out")
        XCTAssertEqual(today.recap?.coverage.captured, 9)
    }
}

final class DemoServicesTests: XCTestCase {
    final class Clock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 1_800_000_000) }

    func testSyncProgressesAndPairingNeedsDeviceCode() async throws {
        let clock = Clock()
        let demo = DemoServices(seed: [], paired: false, stepSeconds: 1, now: { clock.now })
        let claim = try await demo.claim(PairingCode("clippy://pair?v=1&d=dev_demo_002&c=chl_demo_1")!.claimInput, key: "op_claim")
        XCTAssertEqual(claim.state, "pending")
        do { _ = try await demo.confirm(claimID: claim.claimId, proof: ClaimProof(schemaVersion: 1, proofHandle: "12"), key: "op_c1"); XCTFail() } catch {}
        let confirmed = try await demo.confirm(claimID: claim.claimId, proof: ClaimProof(schemaVersion: 1, proofHandle: "482913"), key: "op_c2")
        XCTAssertEqual(confirmed.state, "confirmed")

        let request = try await demo.requestSync(deviceID: "dev_demo_002", key: "op_sync_1")
        XCTAssertEqual(request.state, "waiting_for_device")
        let again = try await demo.requestSync(deviceID: "dev_demo_002", key: "op_sync_2")
        XCTAssertEqual(again.syncRequestId, request.syncRequestId, "one active sync per device")
        clock.now += 10
        let done = try await demo.sync(request.syncRequestId)
        XCTAssertEqual(done.state, "uploaded")
    }
}
