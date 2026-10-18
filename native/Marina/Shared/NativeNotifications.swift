import Foundation
import UserNotifications
import MarinaCore

enum NativeNotifications {
    static let category = "MARINA_CHECKIN"
    static func enable() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([UNNotificationCategory(identifier: category, actions: [], intentIdentifiers: [])])
        return try await center.requestAuthorization(options: [.alert, .sound])
    }
    static func cancel() async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.identifier.hasPrefix("marina.schedule.") }.map(\.identifier))
    }
    static func schedule(_ context: ScheduleContext) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        // Only replace today's cached reminders. Tomorrow's are refreshed by the
        // app, and unrelated notifications are not touched.
        let prefix = "marina.schedule.\(context.date)."
        let old = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: old.filter { $0.identifier.hasPrefix(prefix) }.map(\.identifier))
        for target in context.targets().prefix(24) {
            let when: Date?
            if target.kind == .start { when = MarinaClock.parse(target.reference) }
            else { when = context.events.first(where: { $0.id == target.occurrenceID }).flatMap { MarinaClock.parse($0.plannedEnd) } }
            guard let when, when > Date().addingTimeInterval(5) else { continue }
            let content = UNMutableNotificationContent(); content.title = target.kind == .start ? "Starting now?" : "Finished this event?"
            content.body = "Hold to check in or choose the actual time."
            content.categoryIdentifier = category; content.sound = .default
            if let data = try? JSONEncoder().encode(target) { content.userInfo = ["target": data.base64EncodedString()] }
            let request = UNNotificationRequest(identifier: prefix + target.id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: when.timeIntervalSinceNow, repeats: false))
            try? await center.add(request)
        }
    }
}
