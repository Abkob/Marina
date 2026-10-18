import XCTest
final class MarinaUITests: XCTestCase {
    func testWidgetStateGallery() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--widget-preview"]; app.launch()
        XCTAssertTrue(app.navigationBars["Widget preview"].waitForExistence(timeout: 15))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Widget preview"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.swipeUp()
        let lower = XCTAttachment(screenshot: app.screenshot()); lower.name = "Widget states"; lower.lifetime = .keepAlways; add(lower)
        XCTAssertTrue(app.buttons["Close check-in"].exists)
    }
}
