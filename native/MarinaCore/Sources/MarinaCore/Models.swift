import Foundation

public enum MarinaClock {
    public static func parse(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter(); precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    public static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date)
    }
    public static func day(_ date: Date, timezone: String) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: timezone); f.dateFormat = "yyyy-MM-dd"; return f.string(from: date)
    }
}
public struct ScheduleEvent: Codable, Identifiable, Sendable {
    public let occurrenceID: String
    public let title: String
    public let date: String
    public let plannedStart: String
    public let plannedEnd: String
    public let actualStart: String?
    public let status: String
    public var id: String { occurrenceID }
    enum CodingKeys: String, CodingKey { case occurrenceID = "occurrence_id", title, date, plannedStart = "planned_start", plannedEnd = "planned_end", actualStart = "actual_start", status }
}
public struct PendingActivity: Codable, Identifiable, Sendable {
    public let id: String
    public let occurrenceID: String
    public let date: String
    public let startedAt: String
    public let title: String?
    enum CodingKeys: String, CodingKey { case id, occurrenceID = "occurrence_id", date, startedAt = "started_at", title }
}
public struct ScheduleContext: Codable, Sendable {
    public let date: String
    public let timezone: String
    public let serverNow: String
    public let runningID: String?
    public let events: [ScheduleEvent]
    public let pending: [PendingActivity]
    enum CodingKeys: String, CodingKey { case date, timezone, serverNow = "server_now", runningID = "running_id", events, pending }
    public func targets(now: Date = Date()) -> [CheckInTarget] {
        let ends = pending.sorted { a,b in a.id == runningID ? b.id != runningID : b.id == runningID ? false : a.startedAt < b.startedAt }.map {
            CheckInTarget(id: $0.id, occurrenceID: $0.occurrenceID, date: $0.date, title: $0.title ?? "Activity", kind: .end, sessionID: $0.id, expectedRunningID: runningID, reference: $0.startedAt, timezone: timezone, live: $0.id == runningID)
        }
        let starts = events.filter { event in event.status == "unknown" && event.actualStart == nil && !pending.contains(where: { $0.occurrenceID == event.id }) }.sorted { $0.plannedStart < $1.plannedStart }.map {
            CheckInTarget(id: $0.id, occurrenceID: $0.id, date: $0.date, title: $0.title, kind: .start, sessionID: nil, expectedRunningID: runningID, reference: $0.plannedStart, timezone: timezone, live: $0.date == date && (MarinaClock.parse($0.plannedEnd) ?? .distantPast) > now)
        }
        return ends + starts
    }
    public func primary(now: Date = Date()) -> CheckInTarget? {
        let choices = targets(now: now)
        if let running = choices.first(where: { $0.sessionID == runningID && runningID != nil }) { return running }
        let due = choices.filter { $0.kind == .start && (MarinaClock.parse($0.reference) ?? .distantFuture) <= now }
        // Ambiguous overlaps must open the chooser rather than guessing attendance.
        let ongoing = due.filter { target in events.contains { $0.id == target.occurrenceID && (MarinaClock.parse($0.plannedEnd) ?? .distantPast) > now } }
        if ongoing.count == 1 { return ongoing[0] }
        if ongoing.count > 1 { return nil }
        return choices.first(where: { $0.kind == .end })
    }
}
public struct CheckInTarget: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case start, end }
    public let id: String
    public let occurrenceID: String
    public let date: String
    public let title: String
    public let kind: Kind
    public let sessionID: String?
    public let expectedRunningID: String?
    public let reference: String
    public let timezone: String
    public let live: Bool
    public var label: String { kind == .start ? "Started" : "Ended" }
    public var deepLink: URL {
        var c = URLComponents(); c.scheme = "marina-native"; c.host = "checkin"
        c.queryItems = [URLQueryItem(name: "occurrence", value: occurrenceID)]; return c.url!
    }
}
public struct CheckInCommand: Codable, Sendable {
    public let target: CheckInTarget
    public let requestID: String
    public let instant: String
    public init(target: CheckInTarget, instant: Date, requestID: String = UUID().uuidString) {
        self.target = target; self.instant = MarinaClock.iso(instant); self.requestID = requestID
    }
    public var path: String { target.kind == .start ? "start" : "end" }
    public func body() throws -> Data {
        var value: [String: Any] = [:]
        if target.kind == .start {
            value = ["session_id": requestID, "occurrence_id": target.occurrenceID, "date": target.date, "started_at": instant, "track_live": target.live, "expected_running_id": target.expectedRunningID.map { $0 as Any } ?? NSNull()]
        } else {
            guard let session = target.sessionID else { throw MarinaError.message("Refresh this activity before recording its end.") }
            value = ["session_id": session, "ended_at": instant]
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
public enum MarinaError: Error, LocalizedError {
    case message(String)
    case server(Int, String)
    public var errorDescription: String? { switch self { case .message(let text), .server(_, let text): return text } }
}
public struct MarinaAPI: Sendable {
    public static let origin = URL(string: "https://marina-demol1sin.vercel.app")!
    public let token: String
    private let origin: URL
    public init(token: String, origin: URL = MarinaAPI.origin) { self.token = token; self.origin = origin }
    private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard origin.scheme == "https", origin.host == MarinaAPI.origin.host else { throw MarinaError.message("Invalid Marina server.") }
        guard let url = URL(string: path, relativeTo: origin.appendingPathComponent("api/schedule-shortcuts/"))?.absoluteURL else { throw MarinaError.message("Invalid request.") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Dedicated ephemeral session: no browser cookies, shared caches or persistent token headers.
        let session = URLSession(configuration: .ephemeral); defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MarinaError.message("Marina did not return a response.") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw MarinaError.server(http.statusCode, message ?? "Could not save. Refresh Marina and try again.")
        }
        return data
    }
    public func context(date: String? = nil) async throws -> ScheduleContext {
        let path = "context" + (date.map { "?date=\($0)" } ?? "")
        return try JSONDecoder().decode(ScheduleContext.self, from: await request(path))
    }
    public func send(_ command: CheckInCommand) async throws { _ = try await request(command.path, method: "POST", body: command.body()) }
    public func workContext(available: Bool = false) async throws -> DayWorkContext {
        try JSONDecoder().decode(DayWorkContext.self, from: await request("work/context" + (available ? "?available=1" : "")))
    }
    public func pickWork(id: String, selected: Bool) async throws -> DayWorkContext {
        let data = try JSONSerialization.data(withJSONObject: ["task_id": id, "selected": selected])
        return try JSONDecoder().decode(DayWorkContext.self, from: await request("work/pick", method: "POST", body: data))
    }
    public func sendWork(_ command: DayWorkCommand) async throws { _ = try await request("work/command", method: "POST", body: JSONEncoder().encode(command)) }
}
