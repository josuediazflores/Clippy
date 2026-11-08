import XCTest

@MainActor
final class ClippyUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func field(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.textFields[id].exists ? app.textFields[id] : app.textViews[id]
    }
    /// Selects all existing text through the edit menu, so cursor placement in multi-line fields cannot leave a remainder.
    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.press(forDuration: 1.2)
            let app = XCUIApplication()
            let menu = app.menuItems["Select All"].exists ? app.menuItems["Select All"] : app.buttons["Select All"]
            if menu.waitForExistence(timeout: 3) { menu.tap() }
            field.typeText(XCUIKeyboardKey.delete.rawValue)
        }
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text)
    }
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<6 where !element.isHittable { app.swipeUp() }
    }
    private func launch(_ environment: [String: String], arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = environment
        app.launchArguments += arguments
        app.launch()
        return app
    }

    /// Run by `npm run demo` against the synthetic local server. The harness verifies these writes server-side.
    func testLocalJourneyAgainstServer() {
        let app = launch(["CLIPPY_BASE_URL": "http://127.0.0.1:8787", "CLIPPY_RESET": "1"])
        XCTAssertTrue(app.staticTexts["state-ready"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["recap-summary"].exists)
        screenshot("01-today", app)

        app.buttons["moment-moment_cap_sample_001"].tap()
        XCTAssertTrue(app.staticTexts["moment-title"].waitForExistence(timeout: 5))
        app.buttons["edit-moment"].tap()
        let correction = field(app, "correction-editor")
        XCTAssertTrue(correction.waitForExistence(timeout: 5))
        replace(correction, with: "UI correction saved")
        app.buttons["save-correction"].tap()
        XCTAssertTrue(app.staticTexts["UI correction saved"].waitForExistence(timeout: 5))
        screenshot("02-moment", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let reflection = field(app, "reflection-editor")
        scrollTo(reflection, in: app)
        replace(reflection, with: "UI reflection saved")
        app.buttons["save-reflection"].tap()
        XCTAssertTrue(any(app, "save-status").waitForExistence(timeout: 5))
        XCTAssertEqual(any(app, "save-status").label, "Saved")
        screenshot("03-saved", app)

        app.buttons["History"].tap()
        XCTAssertTrue(app.buttons["day-day_20261107"].waitForExistence(timeout: 5))
        screenshot("04-history", app)

        app.buttons["Device"].tap()
        XCTAssertTrue(app.buttons["sync-now"].waitForExistence(timeout: 5))
        app.buttons["sync-now"].tap()
        XCTAssertTrue(app.staticTexts["sync-status"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["sync-status"].label, "Waiting for Clippy")
        screenshot("05-device-sync", app)

        // Claims are P07. The local server answers 501 and the app says so instead of pretending.
        app.buttons["Pair another"].tap()
        app.buttons["pairing-manual"].tap()
        let input = app.textFields["pairing-input"]
        input.tap(); input.typeText("clippy://pair?v=1&d=dev_sample_009&c=chl_local_1")
        app.buttons["pairing-submit"].tap()
        XCTAssertTrue(app.staticTexts["pairing-failed"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["pairing-failed"].label, "Pairing isn't live yet")
        app.buttons["Close"].tap()

        // Offline: cached recap stays readable; an edit queues and survives a restart without reaching the server.
        app.terminate()
        let offline = launch(["CLIPPY_OFFLINE": "1"])
        XCTAssertTrue(any(offline, "state-offline").waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["recap-summary"].exists)
        XCTAssertTrue(offline.staticTexts["UI correction saved"].exists)
        let offlineReflection = field(offline, "reflection-editor")
        scrollTo(offlineReflection, in: offline)
        replace(offlineReflection, with: "Written offline")
        offline.buttons["save-reflection"].tap()
        XCTAssertEqual(any(offline, "save-status").label, "Queued")
        screenshot("06-offline-queued", offline)
        offline.terminate()
        let restarted = launch(["CLIPPY_OFFLINE": "1"])
        XCTAssertTrue(any(restarted, "queued-edits").waitForExistence(timeout: 5))
        XCTAssertEqual(field(restarted, "reflection-editor").value as? String, "Written offline")
    }

    func testRenderedDomainStatesAndLargeText() {
        for state in ["empty", "pending", "partial", "failure", "ready"] {
            let app = launch(["CLIPPY_FIXTURE": state])
            XCTAssertTrue(app.staticTexts["state-\(state)"].waitForExistence(timeout: 5))
            screenshot("state-\(state)", app)
            app.terminate()
        }
        let app = launch(["CLIPPY_FIXTURE": "ready"], arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssertTrue(app.staticTexts["state-ready"].waitForExistence(timeout: 5))
        screenshot("large-text-ready", app)
        app.buttons["Device"].tap()
        XCTAssertTrue(app.staticTexts["no-device"].waitForExistence(timeout: 5))
    }

    /// Demo adapter only: proves the screens and state handling, not real pairing, BLE, or upload.
    func testDemoPairingSyncAndSettings() {
        let app = launch(["CLIPPY_MODE": "demo", "CLIPPY_RESET": "1"])
        XCTAssertTrue(app.staticTexts["state-ready"].waitForExistence(timeout: 5))
        app.buttons["Device"].tap()
        XCTAssertTrue(app.buttons["sync-now"].waitForExistence(timeout: 5))
        screenshot("demo-device", app)
        app.buttons["sync-now"].tap()
        let status = app.staticTexts["sync-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let uploaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Uploaded'"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [uploaded], timeout: 15), .completed)
        screenshot("demo-synced", app)

        app.buttons["Pair another"].tap()
        screenshot("demo-pair-scan", app)
        app.buttons["pairing-manual"].tap()
        let input = app.textFields["pairing-input"]
        input.tap(); input.typeText("clippy://pair?v=1&d=dev_demo_002&c=chl_demo_1")
        app.buttons["pairing-submit"].tap()
        let code = app.textFields["pairing-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.typeText("482913")
        screenshot("demo-pair-code", app)
        app.buttons["pairing-confirm"].tap()
        XCTAssertTrue(app.staticTexts["pairing-done"].waitForExistence(timeout: 5))
        screenshot("demo-paired", app)
        app.buttons["Done"].tap()

        app.buttons["You"].tap()
        XCTAssertTrue(app.staticTexts["mode"].waitForExistence(timeout: 5))
        screenshot("demo-account", app)
    }
}
