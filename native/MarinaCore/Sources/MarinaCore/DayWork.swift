import Foundation

public struct DayWorkTask: Codable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let context: String
    public let pinned: Bool
}
public struct DayWorkTimer: Codable, Sendable {
    public let sessionId: String
    public let taskId: String
    public let title: String?
    public let startedAt: String
    public let scheduleOccurrenceId: String?
}
public struct DayWorkContext: Codable, Sendable {
    public let date: String
    public let timezone: String
    public let serverNow: String
    public let tasks: [DayWorkTask]
    public let available: [DayWorkTask]?
    public let running: DayWorkTimer?
    enum CodingKeys: String, CodingKey { case date,timezone,tasks,available,running,serverNow = "server_now" }
    public func page(offset: Int, count: Int) -> [DayWorkTask] {
        guard !tasks.isEmpty else { return [] }
        let start = max(0, offset) % tasks.count
        return Array(tasks.dropFirst(start).prefix(count))
    }
    public var isToday: Bool { date == MarinaClock.day(Date(), timezone: timezone) }
}
public struct DayWorkCommand: Codable, Equatable, Sendable {
    public let commandID: String
    public let action: String
    public let taskID: String?
    public let date: String
    public let expectedRunningID: String?
    public let instant: String
    public init(action: String, taskID: String?, date: String, expectedRunningID: String?, instant: Date, commandID: String = UUID().uuidString) {
        self.action = action; self.taskID = taskID; self.date = date; self.expectedRunningID = expectedRunningID
        self.instant = MarinaClock.iso(instant); self.commandID = commandID
    }
    enum CodingKeys: String, CodingKey { case commandID = "command_id", action, taskID = "task_id", date, expectedRunningID = "expected_running_id", instant }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(commandID, forKey: .commandID); try c.encode(action, forKey: .action)
        try c.encode(taskID, forKey: .taskID); try c.encode(date, forKey: .date)
        try c.encode(expectedRunningID, forKey: .expectedRunningID); try c.encode(instant, forKey: .instant)
    }
}
