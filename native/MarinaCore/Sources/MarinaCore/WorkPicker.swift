import Foundation

/// Frozen at touch-down. A refresh/reorder can never change the task selected
/// by a held row index or replace its expected timer with newer server state.
public struct WorkPickerSnapshot: Sendable {
    public let tasks: [DayWorkTask]
    public let date: String
    public let expectedRunningID: String?
    public init(context: DayWorkContext) {
        tasks = context.tasks; date = context.date; expectedRunningID = context.running?.sessionId
    }
    public func index(anchor: Int, translationY: Double) -> Int? {
        guard !tasks.isEmpty else { return nil }
        return min(tasks.count - 1, max(0, anchor + Int((-translationY / 48).rounded())))
    }
    public func command(index: Int, at instant: Date) -> DayWorkCommand? {
        guard tasks.indices.contains(index) else { return nil }
        return DayWorkCommand(action: "start", taskID: tasks[index].id, date: date, expectedRunningID: expectedRunningID, instant: instant)
    }
}
