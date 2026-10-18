import XCTest
final class MarinaUITests: XCTestCase {
    func testTodayTaskStartsSwitchesAndStopsWithOneTap() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--work-preview"]; app.launch()
        let first = app.buttons["work-start-read"]
        XCTAssertTrue(first.waitForExistence(timeout: 15)); first.tap()
        let status = app.staticTexts["work-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5)); XCTAssertTrue(status.label.contains("work started"))
        app.buttons["work-start-solve"].tap()
        XCTAssertTrue(app.buttons["Stop work timer"].exists)
        let running = XCTAttachment(screenshot: app.screenshot()); running.name = "Today work running"; running.lifetime = .keepAlways; add(running)
        app.buttons["Stop work timer"].tap()
        XCTAssertTrue(status.label.contains("work stopped"))
        XCTAssertTrue(app.buttons["work-start-read"].exists)
    }
    func testWidgetStateGallery() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--widget-preview"]; app.launch()
        XCTAssertTrue(app.navigationBars["Widget preview"].waitForExistence(timeout: 15))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Widget preview"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.swipeUp()
        let lower = XCTAttachment(screenshot: app.screenshot()); lower.name = "Widget states"; lower.lifetime = .keepAlways; add(lower)
        XCTAssertTrue(app.buttons["Close check-in"].exists)
    }
    func testHoldAndSlideUsesOfflineCheckIn() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--ui-testing", "--checkin-preview"]; app.launch()
        let reading = app.buttons["checkin-target-reading"]
        XCTAssertTrue(reading.waitForExistence(timeout: 15)); reading.tap()
        let touch = app.descendants(matching: .any)["actual-time-control"].firstMatch
        XCTAssertTrue(touch.waitForExistence(timeout: 5))
        let start = touch.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        let end = touch.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        start.press(forDuration: 0.5, thenDragTo: end)
        let status = app.staticTexts["checkin-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(status.label.contains("Preview only · Started recorded"))
        XCTAssertTrue(app.buttons["checkin-target-previous-session"].exists)
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = "Actual check-in gesture"; image.lifetime = .keepAlways; add(image)
    }
}
