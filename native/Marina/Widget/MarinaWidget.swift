import SwiftUI
import WidgetKit
import AppIntents
import MarinaCore

struct MarinaEntry: TimelineEntry {
    let date: Date
    let context: ScheduleContext?
    let target: CheckInTarget?
    let message: String?
}
struct MarinaProvider: TimelineProvider {
    func placeholder(in context: Context) -> MarinaEntry { MarinaEntry(date: Date(), context: nil, target: nil, message: "Your next check-in") }
    func getSnapshot(in context: Context, completion: @escaping (MarinaEntry) -> Void) { let cache = SharedStore.cache(); completion(MarinaEntry(date: Date(), context: cache.context, target: cache.context?.primary(), message: cache.message)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<MarinaEntry>) -> Void) {
        Task {
            let cached = SharedStore.cache()
            var value = cached.context; var message = cached.message
            do { value = try await SharedStore.refresh(); let fresh = SharedStore.cache(); message = fresh.command == nil ? fresh.message : "Save needs retry" }
            catch { message = (try? SharedStore.connection()) == nil ? "Open Marina to connect" : "Open to refresh · cached schedule" }
            let now = Date(); var dates = [now]
            // Request timeline boundaries in advance. iOS owns actual refresh
            // timing; a stale card never invents a start or end.
            if let value { for event in value.events { for text in [event.plannedStart, event.plannedEnd] { if let d = MarinaClock.parse(text), d > now { dates.append(d) } } } }
            let entries = dates.sorted().prefix(32).map { date in MarinaEntry(date: date, context: value, target: value?.primary(now: date), message: message) }
            completion(Timeline(entries: Array(entries), policy: .after(now.addingTimeInterval(15 * 60))))
        }
    }
}
struct SaveCheckInIntent: AppIntent {
    static var title: LocalizedStringResource = "Record Marina check-in"
    static var description = IntentDescription("Records an explicit start or end. Missing ends remain unconfirmed.")
    static var openAppWhenRun = false
    @Parameter(title: "Check-in") var encodedTarget: String
    init() {}
    init(target: CheckInTarget) { encodedTarget = (try? JSONEncoder().encode(target).base64EncodedString()) ?? "" }
    func perform() async throws -> some IntentResult {
        do {
            guard let data = Data(base64Encoded: encodedTarget) else { throw MarinaError.message("Open Marina to refresh this check-in.") }
            let target = try JSONDecoder().decode(CheckInTarget.self, from: data)
            // The exact displayed occurrence/session is carried with the intent.
            // The server rejects a stale active-timer expectation on switching.
            try await SharedStore.submit(target: target, at: Date())
        } catch {
            var cache = SharedStore.cache(); cache.message = error.localizedDescription; try? SharedStore.write(cache, to: "schedule.json")
        }
        WidgetCenter.shared.reloadTimelines(ofKind: SharedStore.widgetKind)
        return .result()
    }
}
struct MarinaWidgetView: View {
    let entry: MarinaEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        let stale = entry.context == nil || entry.message != nil
        let title = entry.target?.title ?? (entry.context == nil ? "Marina" : "Choose your event")
        let subtitle = entry.message ?? (entry.target?.kind == .end ? "End unconfirmed" : entry.target == nil ? "Open check-in" : "Ready to start?")
        Group {
            if family == .accessoryRectangular {
                Link(destination: entry.target?.deepLink ?? URL(string: "marina-native://checkin")!) { VStack(alignment: .leading) { Text(title).font(.headline).lineLimit(1); Text(subtitle).font(.caption).lineLimit(1) } }
            } else {
                WidgetFace(title: title, subtitle: subtitle, symbol: "play") {
                    if let target = entry.target, !stale {
                        Button(intent: SaveCheckInIntent(target: target)) { Image(systemName: target.kind == .start ? "play.fill" : "stop.fill").frame(width: 44, height: 44) }
                            .buttonStyle(.plain).background(.quaternary, in: Circle()).accessibilityLabel(target.kind == .start ? "Start this event now" : "End this activity now")
                    } else {
                        Link(destination: URL(string: "marina-native://checkin")!) { Image(systemName: "arrow.up.right").frame(width: 44, height: 44) }.accessibilityLabel("Open Marina check-in")
                    }
                }
            }
        }
        .containerBackground(.background, for: .widget)
        .widgetURL(entry.target?.deepLink ?? URL(string: "marina-native://checkin")!)
    }
}
@main struct MarinaWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedStore.widgetKind, provider: MarinaProvider()) { MarinaWidgetView(entry: $0) }
            .configurationDisplayName("Marina").description("Your event. One check-in.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
