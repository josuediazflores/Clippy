import XCTest

final class ClippyUITests: XCTestCase {
    func testFoundationLoads() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Synthetic data only"].waitForExistence(timeout: 5))
    }
}
