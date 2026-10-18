import SwiftUI
import WebKit
import SafariServices
import UserNotifications
import WidgetKit
import MarinaCore

@main struct MarinaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        WindowGroup {
            MarinaRoot(model: model).onOpenURL { url in
                guard url.scheme == "marina-native", url.host == "checkin" else { return }
                model.selectedID = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "occurrence" })?.value
                model.showControls = true
            }
        }
    }
}
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self; return true
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { NotificationCenter.default.post(name: .marinaCheckIn, object: nil) }
    }
}
extension Notification.Name { static let marinaCheckIn = Notification.Name("marina.checkin") }

@MainActor final class CompanionModel: ObservableObject {
    @Published var showControls = false
    @Published var selectedID: String?
    @Published var context: ScheduleContext?
    @Published var busy = false
    @Published var message = ""
    @Published var connection = (try? SharedStore.connection()) != nil
    @Published var webError: String?
    @Published var preview = false
    let webView: WKWebView
    init() {
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
    }
    func refresh() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            context = try await SharedStore.refresh(); connection = true
            if let context { await NativeNotifications.schedule(context) }
            message = SharedStore.cache().command == nil ? "" : "A save is unconfirmed. Retry its original time below."
            WidgetCenter.shared.reloadTimelines(ofKind: SharedStore.widgetKind)
        } catch { message = error.localizedDescription }
    }
    func connect() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            _ = try SharedStore.container()
            guard webView.url?.scheme == "https", webView.url?.host == MarinaAPI.origin.host else { throw MarinaError.message("Open Marina and sign in first.") }
            let script = "const r=await fetch('/api/schedule-review/shortcuts/keys',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'Marina iPhone'})});if(!r.ok)throw new Error('Sign into Marina first, then connect again.');return await r.json();"
            let result = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
            guard let value = result as? [String: Any], let token = value["token"] as? String, let id = value["id"] as? String, token.hasPrefix("marina_sc_") else { throw MarinaError.message("Connection could not be confirmed.") }
            do { try SharedStore.write(NativeConnection(id: id, token: token), to: "connection.json") }
            catch {
                _ = try? await webView.callAsyncJavaScript("return await fetch('/api/schedule-review/shortcuts/keys/'+id,{method:'DELETE',credentials:'same-origin'}).then(r=>r.ok)", arguments: ["id": id], in: nil, contentWorld: .page)
                throw error
            }
            connection = true; context = try await SharedStore.refresh(); message = "Connected"
        } catch { message = error.localizedDescription }
    }
    func submit(_ target: CheckInTarget, time: Date) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            try await SharedStore.submit(target: target, at: time); context = SharedStore.cache().context
            message = target.kind == .start ? "Start saved · end stays unconfirmed" : "End saved"
        } catch { message = error.localizedDescription }
    }
    func disconnect() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let key = try SharedStore.connection()
            guard webView.url?.host == MarinaAPI.origin.host else { throw MarinaError.message("Open Marina and sign in to revoke this connection.") }
            let result = try await webView.callAsyncJavaScript("return await fetch('/api/schedule-review/shortcuts/keys/'+id,{method:'DELETE',credentials:'same-origin'}).then(r=>r.ok)", arguments: ["id": key.id], in: nil, contentWorld: .page)
            guard result as? Bool == true else { throw MarinaError.message("Sign into Marina to revoke the connection. It has not been removed yet.") }
            try SharedStore.removeConnection(); await NativeNotifications.cancel(); connection = false; context = nil; message = "Disconnected"
        } catch { message = error.localizedDescription }
    }
    func enableReminders() async {
        do {
            guard try await NativeNotifications.enable() else { throw MarinaError.message("Notifications are disabled in iPhone Settings.") }
            if let context { await NativeNotifications.schedule(context)
                var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: context.timezone) ?? .current
                if let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date()), let connection = try? SharedStore.connection(), let next = try? await MarinaAPI(token: connection.token).context(date: MarinaClock.day(tomorrow, timezone: context.timezone)) { await NativeNotifications.schedule(next) }
            }
            message = "Reminders set from the latest schedule. Open Marina daily to refresh them."
        } catch { message = error.localizedDescription }
    }
}

struct MarinaRoot: View {
    @ObservedObject var model: CompanionModel
    var body: some View {
        ZStack(alignment: .topTrailing) {
            MarinaWebView(model: model)
            Button { model.showControls = true } label: { Image(systemName: "rectangle.stack").frame(width: 44, height: 44).background(.regularMaterial, in: Circle()) }
                .tint(.secondary).padding(8).accessibilityLabel("iPhone check-in and widget")
            if let error = model.webError {
                VStack(spacing: 16) { Text("Couldn’t load Marina").font(.headline); Text(error).font(.subheadline).foregroundStyle(.secondary)
                    Button("Try again") { model.webError = nil; model.webView.load(URLRequest(url: MarinaAPI.origin)) }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
            }
        }
        .sheet(isPresented: $model.showControls) { CheckInSheet(model: model).presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
        .onReceive(NotificationCenter.default.publisher(for: .marinaCheckIn)) { _ in model.showControls = true }
        .task { if ProcessInfo.processInfo.arguments.contains("--widget-preview") { model.preview = true; model.showControls = true } }
    }
}
struct CheckInSheet: View {
    @ObservedObject var model: CompanionModel
    @State private var selected: CheckInTarget?
    @State private var exactTime = Date()
    @State private var exact = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.preview { WidgetGallery() }
                    else if !model.connection {
                        Text("Your full Marina app is already here. Connect its widget after signing in.").foregroundStyle(.secondary)
                        Button("Connect widget") { Task { await model.connect() } }.disabled(model.busy)
                    } else {
                        let targets = model.context?.targets() ?? []
                        if targets.isEmpty { Text("Nothing waiting for check-in.").foregroundStyle(.secondary) }
                        ForEach(targets) { target in
                            Button { selected = target; exact = false; exactTime = defaultTime(target) } label: {
                                HStack { VStack(alignment: .leading, spacing: 4) { Text(target.title).foregroundStyle(.primary); Text(target.kind == .end ? "End unconfirmed" : "Not started").font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }.frame(minHeight: 44)
                            }.buttonStyle(.plain)
                        }
                        if let target = selected ?? model.context?.primary() {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(target.title).font(.headline)
                                if target.kind == .start && target.expectedRunningID != nil { Text("Moving on leaves the previous activity’s end unconfirmed.").font(.caption).foregroundStyle(.secondary) }
                                HoldTimeView(target: target, disabled: model.busy, initial: defaultTime(target), onTap: { selected = target; exactTime = defaultTime(target); exact = true }, onChoose: { time in Task { await model.submit(target, time: time); selected = nil } })
                                    .frame(minHeight: 74).id(target.id)
                                if exact {
                                    DatePicker("Actual time", selection: $exactTime, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
                                        .environment(\.timeZone, TimeZone(identifier: target.timezone) ?? .current)
                                    HStack { Spacer(); Button { Task { await model.submit(target, time: exactTime); exact = false; selected = nil } } label: { Image(systemName: "checkmark").frame(width: 44, height: 44) }.disabled(model.busy).accessibilityLabel("Save actual time") }
                                }
                            }.padding(16).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                        }
                        if let command = SharedStore.cache().command {
                            Button("Retry original check-in") { Task { await model.submit(command.target, time: MarinaClock.parse(command.instant) ?? Date()) } }.disabled(model.busy)
                        }
                        Divider()
                        Button("Enable event reminders") { Task { await model.enableReminders() } }.frame(minHeight: 44)
                        Button("Preview widget") { model.preview = true }.frame(minHeight: 44)
                        Button("Disconnect widget", role: .destructive) { Task { await model.disconnect() } }.font(.caption).frame(minHeight: 44)
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity) }
                    if !model.message.isEmpty { Text(model.message).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("checkin-status") }
                }.padding(20)
            }
            .navigationTitle(model.preview ? "Widget preview" : "Check in").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { if model.preview { model.preview = false } else { model.showControls = false } } label: { Image(systemName: "xmark") }.accessibilityLabel("Close check-in") } }
            .task { if model.connection && !model.preview { await model.refresh(); if let id = model.selectedID { selected = model.context?.targets().first(where: { $0.occurrenceID == id }); model.selectedID = nil } } }
            .refreshable { await model.refresh() }
        }
    }
    private func defaultTime(_ target: CheckInTarget) -> Date {
        if target.kind == .start && !target.live { return min(Date(), MarinaClock.parse(target.reference) ?? Date()) }
        return Date()
    }
}
struct HoldTimeView: UIViewRepresentable {
    let target: CheckInTarget; let disabled: Bool; let initial: Date; let onTap: () -> Void; let onChoose: (Date) -> Void
    func makeUIView(context: Context) -> HoldTimeControl { let view = HoldTimeControl(); view.instant = initial; return view }
    func updateUIView(_ view: HoldTimeControl, context: Context) { view.caption = target.label; view.timezone = TimeZone(identifier: target.timezone) ?? .current; view.isEnabled = !disabled; view.onTap = onTap; view.onChoose = onChoose }
}
