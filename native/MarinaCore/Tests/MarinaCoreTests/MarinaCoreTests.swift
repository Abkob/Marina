import XCTest
@testable import MarinaCore
final class MarinaCoreTests: XCTestCase {
    private func context(events: String, pending: String = "[]", running: String = "null") throws -> ScheduleContext {
        try JSONDecoder().decode(ScheduleContext.self, from: Data("""
        {"date":"2026-10-18","timezone":"Asia/Beirut","server_now":"2026-10-18T07:00:00Z","running_id":\(running),"events":\(events),"pending":\(pending)}
        """.utf8))
    }
    private let event = """
    {"occurrence_id":"event:a:2026-10-18","title":"Reading","date":"2026-10-18","planned_start":"2026-10-18T06:00:00Z","planned_end":"2026-10-18T08:00:00Z","actual_start":null,"status":"unknown"}
    """
    func testOverlapRequiresChooser() throws {
        let ctx = try context(events: "[\(event),\(event.replacingOccurrences(of: "event:a:", with: "event:b:"))]")
        XCTAssertNil(ctx.primary(now: MarinaClock.parse("2026-10-18T07:00:00Z")!))
    }
    func testStartCarriesStableRetryIDAndNullRunningGuard() throws {
        let ctx = try context(events: "[\(event)]"), target = try XCTUnwrap(ctx.primary(now: MarinaClock.parse("2026-10-18T07:00:00Z")!))
        let command = CheckInCommand(target: target, instant: MarinaClock.parse("2026-10-18T07:00:00Z")!, requestID: "stable")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: command.body()) as? [String: Any])
        XCTAssertEqual(body["session_id"] as? String, "stable"); XCTAssertTrue(body["expected_running_id"] is NSNull)
        let persisted = try JSONDecoder().decode(CheckInCommand.self, from: JSONEncoder().encode(command))
        XCTAssertEqual(try persisted.body(), try command.body())
    }
    func testKnownStartProducesOnlyEndChoice() throws {
        let started = event.replacingOccurrences(of: "\"actual_start\":null", with: "\"actual_start\":\"2026-10-18T06:15:00Z\"")
        let pending = """
        [{"id":"session","occurrence_id":"event:a:2026-10-18","date":"2026-10-18","started_at":"2026-10-18T06:15:00Z","title":"Reading"}]
        """
        let ctx = try context(events: "[\(started)]", pending: pending, running: "\"session\"")
        XCTAssertEqual(ctx.targets().count, 1); XCTAssertEqual(ctx.primary()?.kind, .end)
        let command = CheckInCommand(target: try XCTUnwrap(ctx.primary()), instant: MarinaClock.parse("2026-10-18T07:00:00Z")!)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: command.body()) as? [String: Any]); XCTAssertEqual(body["session_id"] as? String, "session"); XCTAssertNil(body["started_at"])
    }
    func testPreciseAndWholeSecondDatesDecode() { XCTAssertNotNil(MarinaClock.parse("2026-10-18T07:00:00.123Z")); XCTAssertNotNil(MarinaClock.parse("2026-10-18T07:00:00Z")) }
    func testDeepLinkContainsNoCredentialOrAutomaticMutation() throws {
        let target = try XCTUnwrap(context(events: "[\(event)]").primary(now: MarinaClock.parse("2026-10-18T07:00:00Z")!))
        XCTAssertEqual(target.deepLink.scheme, "marina-native"); XCTAssertFalse(target.deepLink.absoluteString.contains("token")); XCTAssertEqual(target.deepLink.host, "checkin")
    }
}
