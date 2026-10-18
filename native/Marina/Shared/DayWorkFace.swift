import SwiftUI
import MarinaCore

/// Shared with the in-app preview; real widget uses App Intent actions.
struct DayWorkFace<Action: View>: View {
    let context: DayWorkContext?
    let offset: Int
    let compact: Bool
    let message: String?
    let action: (DayWorkTask?, Bool) -> Action
    init(context: DayWorkContext?, offset: Int, compact: Bool, message: String?, @ViewBuilder action: @escaping (DayWorkTask?, Bool) -> Action) {
        self.context = context; self.offset = offset; self.compact = compact; self.message = message; self.action = action
    }
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 0) {
            Text(context?.running == nil ? "Tasks for today" : "Working").font(.caption).foregroundStyle(.secondary)
            if let running = context?.running {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(running.title ?? "Work timer").font(.headline).lineLimit(compact ? 2 : 1)
                        if let date = MarinaClock.parse(running.startedAt) { Text(date, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                    action(nil, true)
                }.frame(minHeight: 44)
            }
            if let context, !context.tasks.isEmpty {
                ForEach(context.page(offset: offset, count: compact ? (context.running == nil ? 1 : 0) : (context.running == nil ? 3 : 2))) { task in
                    action(task, false)
                }
            } else if context?.running == nil {
                Text(context == nil ? "Open Marina to connect" : "Choose today’s tasks in Marina").font(.subheadline).foregroundStyle(.secondary)
            }
            if let message { Text(message).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
            if compact { Spacer(minLength: 0) }
        }
    }
}
