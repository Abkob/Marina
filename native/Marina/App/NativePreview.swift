import Foundation
import MarinaCore

/// Offline Simulator fixtures. No connection key, reminder or cloud write.
enum NativePreview {
    static func workContext(running: String? = nil) -> DayWorkContext? {
        let tasks: [[String: Any]] = [("read", "Read chapter 4", "Biology"), ("solve", "Solve problem 2", "Problem set"), ("draft", "Draft introduction", "Report")].map { ["id": $0.0, "title": $0.1, "context": $0.2, "pinned": true] }
        var value: [String: Any] = ["date": MarinaClock.day(Date(), timezone: "UTC"), "timezone": "UTC", "server_now": MarinaClock.iso(Date()), "tasks": tasks, "available": tasks]
        if let running { value["running"] = ["sessionId": "preview-\(running)", "taskId": running, "title": tasks.first { $0["id"] as? String == running }?["title"] as? String ?? "Work", "startedAt": MarinaClock.iso(Date().addingTimeInterval(-600))] }
        return try? JSONDecoder().decode(DayWorkContext.self, from: JSONSerialization.data(withJSONObject: value))
    }
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
