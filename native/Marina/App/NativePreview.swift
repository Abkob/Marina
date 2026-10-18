import Foundation
import MarinaCore

/// Offline Simulator fixtures. No connection key, reminder or cloud write.
enum NativePreview {
    static var isUITesting: Bool {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.arguments.contains("--ui-testing")
        #else
        return false
        #endif
    }
    static func context() -> ScheduleContext? {
        let now = Date(), day = MarinaClock.day(Date(), timezone: "UTC")
        let event: (String, String) -> [String: Any] = { id, title in
            ["occurrence_id": id, "title": title, "date": day,
             "planned_start": MarinaClock.iso(now.addingTimeInterval(-1800)),
             "planned_end": MarinaClock.iso(now.addingTimeInterval(1800)),
             "status": "unknown"]
        }
        let value: [String: Any] = ["date": day, "timezone": "UTC", "server_now": MarinaClock.iso(now),
            "events": [event("reading", "Reading"), event("revision", "Revision")],
            "pending": [["id": "previous-session", "occurrence_id": "previous-event", "date": day,
                         "started_at": MarinaClock.iso(now.addingTimeInterval(-7200)), "title": "Previous study"]]]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(ScheduleContext.self, from: data)
    }
}
