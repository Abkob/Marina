import SwiftUI
import MarinaCore

struct LockWorkFace<Action: View>: View {
    let context: DayWorkContext?
    let message: String?
    let action: Action
    init(context: DayWorkContext?, message: String?, @ViewBuilder action: () -> Action) { self.context = context; self.message = message; self.action = action() }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(context?.running?.title ?? context?.tasks.first?.title ?? "Choose work").font(.caption.weight(.medium)).lineLimit(2).privacySensitive()
                if let message { Text(message).font(.caption2).lineLimit(1) }
                else if let start = context?.running?.startedAt, let date = MarinaClock.parse(start) { Text(date, style: .timer).font(.caption2.monospacedDigit()) }
                else { Text("Today’s work").font(.caption2).lineLimit(1) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            action
        }.frame(minHeight: 44)
    }
}
