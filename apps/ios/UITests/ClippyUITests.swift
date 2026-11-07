import XCTest

@MainActor
final class ClippyUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.95)).tap()
        let current = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 5) + text)
        XCTAssertEqual(field.value as? String, text)
    }
    func testLiveRecapAndEditsThenOfflineCache() {
        let app = XCUIApplication()
        app.launchEnvironment["CLIPPY_BASE_URL"] = "http://127.0.0.1:8787"
        app.launch()
        XCTAssertTrue(app.staticTexts["state-ready"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["recap-summary"].exists)
        screenshot("01-ready", app)
        app.buttons["correct-moment_cap_sample_001"].tap()
        let correction = app.textFields["correction-editor"].exists ? app.textFields["correction-editor"] : app.textViews["correction-editor"]
        XCTAssertTrue(correction.waitForExistence(timeout: 5))
        replace(correction, with: "UI correction saved")
        app.buttons["save-correction"].tap()
        XCTAssertTrue(app.staticTexts["UI correction saved"].waitForExistence(timeout: 5))
        for _ in 0..<4 { if app.buttons["save-reflection"].isHittable { break }; app.swipeUp() }
        let reflection = app.textFields["reflection-editor"].exists ? app.textFields["reflection-editor"] : app.textViews["reflection-editor"]
        XCTAssertTrue(reflection.exists)
        replace(reflection, with: "UI reflection saved")
        app.buttons["save-reflection"].tap()
        XCTAssertTrue(app.staticTexts["Reflection saved"].waitForExistence(timeout: 5))
        screenshot("02-saved-edits", app)
        app.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
        screenshot("history", app)
        app.buttons["Device"].tap()
        app.buttons["sync-now"].tap()
        XCTAssertTrue(app.staticTexts["Sync requested. Waiting for the simulated device."].waitForExistence(timeout: 5))
        screenshot("device", app)
        app.terminate()
        app.launchEnvironment["CLIPPY_OFFLINE"] = "1"
        app.launch()
        XCTAssertTrue(app.staticTexts["state-offline"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["recap-summary"].exists)
        screenshot("03-offline", app)
    }
    func testRenderedDomainStatesAndLargeText() {
        for state in ["empty", "pending", "partial", "failure", "ready"] {
            let app = XCUIApplication()
            app.launchEnvironment["CLIPPY_FIXTURE"] = state
            app.launch()
            XCTAssertTrue(app.staticTexts["state-\(state)"].waitForExistence(timeout: 5))
            screenshot("state-\(state)", app)
            app.terminate()
        }
        let app = XCUIApplication()
        app.launchEnvironment["CLIPPY_FIXTURE"] = "ready"
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.staticTexts["state-ready"].waitForExistence(timeout: 5))
        screenshot("large-text-ready", app)
    }
}
