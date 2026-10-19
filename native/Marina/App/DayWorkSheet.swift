import SwiftUI
import MarinaCore
import WidgetKit

struct DayWorkSheet: View {
    @ObservedObject var model: CompanionModel
    @State private var context: DayWorkContext?
    @State private var message = ""
    @State private var busy = false
    @State private var choosing = false
    @State private var search = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if model.isUITesting && ProcessInfo.processInfo.arguments.contains("--work-widget-gallery") { DayWorkLayoutGallery() }
                    Text("Tap a task to start. Choosing another switches your work timer.").font(.caption).foregroundStyle(.secondary)
                    if context?.tasks.isEmpty == false {
                        WorkTaskPicker(context: context, disabled: busy, onChoose: { command in Task { await perform(command) } }, onCancel: { message = "Selection canceled · timer unchanged" }).frame(minHeight: 166)
                    }
                    if let running = context?.running {
                        HStack {
                            VStack(alignment: .leading) { Text(running.title ?? "Working").font(.headline); if let date = MarinaClock.parse(running.startedAt) { Text(date, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(.secondary) } }
                            Spacer()
                            Button { run(action: "stop", id: running.taskId) } label: { Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle()) }.buttonStyle(.plain).disabled(busy).accessibilityLabel("Stop work timer")
                        }
                    }
                    ForEach(context?.tasks ?? []) { task in
                        HStack {
                            Button { run(action: "start", id: task.id) } label: {
                                HStack { VStack(alignment: .leading, spacing: 3) { Text(task.title).lineLimit(2); Text(task.context).font(.caption).foregroundStyle(.secondary).lineLimit(1) }; Spacer(); Image(systemName: context?.running?.taskId == task.id ? "checkmark" : "play.fill").font(.caption) }.frame(minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(busy).accessibilityIdentifier("work-start-\(task.id)")
                            if task.pinned { Button { pick(task.id, selected: false) } label: { Image(systemName: "minus").font(.caption).frame(width: 44, height: 44) }.tint(.secondary).accessibilityLabel("Remove \(task.title) from today") }
                        }
                    }
                    if context?.tasks.isEmpty == true { Text("Add a task below, or link work to today’s calendar.").font(.subheadline).foregroundStyle(.secondary) }
                    Button { choosing.toggle() } label: { Label("Choose today’s tasks", systemImage: "plus").font(.subheadline).frame(minHeight: 44).contentShape(Rectangle()) }.tint(.secondary).disabled(busy)
                    if choosing {
                        TextField("Find a task", text: $search).textFieldStyle(.roundedBorder)
                        ForEach((context?.available ?? []).filter { !($0.pinned) && (search.isEmpty || ($0.title + " " + $0.context).localizedCaseInsensitiveContains(search)) }) { task in
                            Button { pick(task.id, selected: true) } label: { HStack { VStack(alignment: .leading) { Text(task.title); Text(task.context).font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "plus").font(.caption) }.frame(minHeight: 44).contentShape(Rectangle()) }.buttonStyle(.plain).disabled(busy)
                        }
                    }
                    if !model.isUITesting, let pending = DayWorkStore.pending() {
                        Button("Retry original timer save") { Task { await perform(pending) } }.frame(minHeight: 44).disabled(busy)
                    }
                    if busy { ProgressView() }
                    if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("work-status") }
                    DisclosureGroup("Widget connection") {
                        Text("Allows schedule check-ins and task timer start, switch, stop, and today-list choices. Existing schedule-only connections need reconnecting.").font(.caption).foregroundStyle(.secondary)
                        Button("Connect task widget") { Task { await model.connect(); message = model.message; await refresh() } }.frame(minHeight: 44).disabled(busy || model.busy)
                        Text("Then hold the Home Screen, add a widget, and choose Marina → Tasks for today.").font(.caption).foregroundStyle(.secondary)
                    }.font(.caption).tint(.secondary)
                }.padding(20)
            }.navigationTitle("Tasks for today").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button { model.showWork = false } label: { Image(systemName: "calendar").frame(width: 44, height: 44) }.tint(.secondary).accessibilityLabel("Calendar check-in") }; ToolbarItem(placement: .topBarTrailing) { Button { model.showControls = false } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.tint(.secondary).accessibilityLabel("Close tasks") } }
                .task { await refresh() }.refreshable { await refresh() }
        }
    }
    private func refresh() async {
        if model.isUITesting { if context == nil { context = NativePreview.workContext() }; return }
        do { context = try await DayWorkStore.refresh(available: true); message = DayWorkStore.cache().message ?? "" }
        catch { context = DayWorkStore.cache().context; message = error.localizedDescription }
    }
    private func run(action: String, id: String) {
        guard let context, !busy else { return }
        let command = DayWorkCommand(action: action, taskID: id, date: context.date, expectedRunningID: context.running?.sessionId, instant: Date())
        Task { await perform(command) }
    }
    private func perform(_ command: DayWorkCommand) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        if model.isUITesting { context = NativePreview.workContext(running: command.action == "start" ? command.taskID : nil); message = "Preview only · \(command.action == "start" ? "work started" : "work stopped") · \(command.taskID ?? "")"; return }
        do { try await DayWorkStore.submit(command); await refresh() } catch { message = error.localizedDescription }
    }
    private func pick(_ id: String, selected: Bool) {
        guard !busy, !model.isUITesting else { return }; busy = true
        Task { defer { busy = false }; do { context = try await MarinaAPI(token: SharedStore.connection().token).pickWork(id: id, selected: selected); _ = try? await DayWorkStore.refresh(); WidgetCenter.shared.reloadAllTimelines() } catch { message = error.localizedDescription } }
    }
}

struct DayWorkLayoutGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Home Screen layout preview · sample data").font(.caption).foregroundStyle(.secondary)
            LockWorkFace(context: NativePreview.workContext(running: "solve"), message: nil) {
                Image(systemName: "xmark").frame(width: 44, height: 44)
                Image(systemName: "chevron.up.chevron.down").font(.caption).frame(width: 44, height: 44)
            }.frame(width: 170, height: 64).padding(8).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            card(NativePreview.workContext(), compact: false)
            card(NativePreview.workContext(running: "solve"), compact: false)
            card(NativePreview.workContext(), compact: true)
        }.accessibilityIdentifier("work-widget-gallery")
    }
    private func card(_ context: DayWorkContext?, compact: Bool) -> some View {
        DayWorkFace(context: context, offset: 0, compact: compact, message: nil) { task, _ in
            if let task { DayWorkTaskLabel(task: task, running: context?.running?.taskId == task.id) }
            else { Image(systemName: "xmark").frame(width: 44, height: 44) }
        }.padding(12).frame(width: compact ? 170 : 330, height: 170).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
    }
}
