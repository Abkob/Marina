import SwiftUI
import WidgetKit
import AppIntents
import MarinaCore

struct DayWorkEntry: TimelineEntry { let date: Date; let cache: DayWorkCache }
struct DayWorkProvider: TimelineProvider {
    func placeholder(in context: Context) -> DayWorkEntry { DayWorkEntry(date: Date(), cache: DayWorkCache()) }
    func getSnapshot(in context: Context, completion: @escaping (DayWorkEntry) -> Void) { completion(DayWorkEntry(date: Date(), cache: DayWorkStore.cache())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<DayWorkEntry>) -> Void) {
        Task {
            do { _ = try await DayWorkStore.refresh() } catch { var cache = DayWorkStore.cache(); cache.message = error.localizedDescription; try? SharedStore.write(cache, to: "day-work.json") }
            completion(Timeline(entries: [DayWorkEntry(date: Date(), cache: DayWorkStore.cache())], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }
}
struct WorkActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Start or stop Marina work"
    static var openAppWhenRun = false
    @Parameter(title: "Action") var action: String
    @Parameter(title: "Task") var taskID: String
    @Parameter(title: "Day") var date: String
    @Parameter(title: "Expected timer") var expected: String
    @Parameter(title: "Command") var commandID: String
    init() {}
    init(action: String, taskID: String, context: DayWorkContext, commandID: String = UUID().uuidString) {
        self.action = action; self.taskID = taskID; self.date = context.date
        self.expected = context.running?.sessionId ?? ""; self.commandID = commandID
    }
    func perform() async throws -> some IntentResult {
        do {
            let command = DayWorkCommand(action: action, taskID: taskID.isEmpty ? nil : taskID, date: date, expectedRunningID: expected.isEmpty ? nil : expected, instant: Date(), commandID: commandID)
            try await DayWorkStore.submit(command)
        } catch { DayWorkStore.message(error.localizedDescription) }
        WidgetCenter.shared.reloadAllTimelines(); return .result()
    }
}
struct RetryWorkIntent: AppIntent {
    static var title: LocalizedStringResource = "Retry original timer save"
    static var openAppWhenRun = false
    func perform() async throws -> some IntentResult {
        do { if let command = DayWorkStore.pending() { try await DayWorkStore.submit(command) } }
        catch { DayWorkStore.message(error.localizedDescription) }
        WidgetCenter.shared.reloadAllTimelines(); return .result()
    }
}
struct PageWorkIntent: AppIntent {
    static var title: LocalizedStringResource = "More today tasks"
    static var openAppWhenRun = false
    @Parameter(title: "Page offset") var offset: Int
    init() {}
    init(offset: Int) { self.offset = offset }
    func perform() async throws -> some IntentResult {
        var cache = DayWorkStore.cache(); cache.offset = max(0, offset)
        try SharedStore.write(cache, to: "day-work.json")
        WidgetCenter.shared.reloadTimelines(ofKind: DayWorkStore.kind); return .result()
    }
}
struct DayWorkWidgetView: View {
    let entry: DayWorkEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        let cache = entry.cache
        let pending = DayWorkStore.pending() != nil
        HStack(alignment: .center, spacing: 4) {
            DayWorkFace(context: cache.context, offset: cache.offset, compact: family == .systemSmall, message: cache.message) { task, stopping in
                if let context = cache.context, !pending, context.isToday || stopping {
                    if stopping, let running = context.running, running.scheduleOccurrenceId != nil {
                        Link(destination: URL(string: "marina-native://checkin")!) { Image(systemName: "arrow.up.right").frame(width: 44, height: 44) }.accessibilityLabel("Open calendar check-in to end this event")
                    } else {
                        Button(intent: WorkActionIntent(action: stopping ? "stop" : "start", taskID: task?.id ?? context.running?.taskId ?? "", context: context)) {
                            if let task { DayWorkTaskLabel(task: task, running: context.running?.taskId == task.id) }
                            else { Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle()) }
                        }.buttonStyle(.plain).accessibilityLabel(task.map { "Start work on \($0.title)" } ?? "Stop work timer")
                    }
                } else {
                    Link(destination: URL(string: "marina-native://work")!) { Text(task?.title ?? "Open Marina").font(.subheadline).frame(minHeight: 44) }
                }
            }
            VStack {
                if pending { Button(intent: RetryWorkIntent()) { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("Retry original timer save") }
                if let context = cache.context, context.tasks.count > (family == .systemSmall ? 1 : (context.running == nil ? 3 : 2)), !(family == .systemSmall && context.running != nil) {
                    let next = cache.offset + (family == .systemSmall ? 1 : (context.running == nil ? 3 : 2))
                    Button(intent: PageWorkIntent(offset: next >= context.tasks.count ? 0 : next)) { Image(systemName: "chevron.right").font(.caption).frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("More today tasks")
                }
            }
        }.padding(12).containerBackground(.background, for: .widget).widgetURL(URL(string: "marina-native://work")!)
    }
}
struct MarinaDayWorkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: DayWorkStore.kind, provider: DayWorkProvider()) { DayWorkWidgetView(entry: $0) }
            .configurationDisplayName("Tasks for today").description("Tap a task to start work. Switch safely. Stop without completing.")
            .supportedFamilies([.systemSmall, .systemMedium])
            .contentMarginsDisabled()
    }
}
