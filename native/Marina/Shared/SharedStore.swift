import Foundation
import MarinaCore
import WidgetKit
import Darwin

struct NativeConnection: Codable { let id: String; let token: String }
struct NativeCache: Codable {
    var context: ScheduleContext?
    var updatedAt: Date?
    var message: String?
    var command: CheckInCommand?
}
private struct PendingCommandFile: Codable { let command: CheckInCommand? }
enum SharedStore {
    static let widgetKind = "MarinaSchedule"
    static func container() throws -> URL {
        // AltStore rewrites group identifiers while re-signing. Read the actual
        // profile rather than assuming the source identifier survived signing.
        var groups = [Bundle.main.object(forInfoDictionaryKey: "MarinaAppGroup") as? String ?? "group.com.abkob.marina"]
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let bytes = try? Data(contentsOf: url), let raw = String(data: bytes, encoding: .isoLatin1),
           let start = raw.range(of: "<?xml"), let end = raw.range(of: "</plist>", range: start.lowerBound..<raw.endIndex),
           let data = raw[start.lowerBound..<end.upperBound].data(using: .utf8),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let entitlements = plist["Entitlements"] as? [String: Any],
           let actual = entitlements["com.apple.security.application-groups"] as? [String] { groups = actual + groups }
        for group in groups {
            if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) { return url }
        }
        throw MarinaError.message("Widget storage is unavailable. Keep both extensions when installing, and check App Group provisioning.")
    }
    static func read<T: Decodable>(_ name: String, as: T.Type) throws -> T {
        let url = try container().appendingPathComponent(name)
        var failure: NSError?; var output: Result<T, Error>?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &failure) { path in
            output = Result { try JSONDecoder().decode(T.self, from: Data(contentsOf: path)) }
        }
        if let failure { throw failure }; guard let output else { throw MarinaError.message("Storage is unavailable.") }; return try output.get()
    }
    static func write<T: Encodable>(_ value: T, to name: String) throws {
        let url = try container().appendingPathComponent(name), data = try JSONEncoder().encode(value)
        var failure: NSError?; var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &failure) { path in
            do { try data.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
            catch { writeError = error }
        }
        if let failure { throw failure }; if let writeError { throw writeError }
    }
    static func connection() throws -> NativeConnection { try read("connection.json", as: NativeConnection.self) }
    static func cache() -> NativeCache {
        var value = (try? read("schedule.json", as: NativeCache.self)) ?? NativeCache()
        value.command = (try? read("pending-command.json", as: PendingCommandFile.self))?.command
        return value
    }
    static func removeConnection() throws {
        let base = try container()
        for name in ["connection.json", "schedule.json", "pending-command.json", "day-work.json", "pending-work.json"] {
            let url = base.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
    static func refresh() async throws -> ScheduleContext {
        let context = try await MarinaAPI(token: connection().token).context()
        var cache = cache(); cache.context = context; cache.updatedAt = Date()
        if cache.message == "Saved" { cache.message = nil }
        try write(cache, to: "schedule.json"); return context
    }
    static func submit(target: CheckInTarget, at time: Date) async throws {
        let lockPath = try container().appendingPathComponent("checkin.lock").path
        let fd = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw MarinaError.message("Check-in storage is unavailable.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw MarinaError.message("Another check-in is saving. Wait and refresh.") }
        defer { flock(fd, LOCK_UN); close(fd) }
        guard DayWorkStore.pending() == nil else { throw MarinaError.message("Retry the unconfirmed task timer save first.") }
        var cache = cache()
        // Preserve a failed request's ID and chosen time: a lost successful
        // response must never generate another start on retry.
        let command: CheckInCommand
        if let pending = cache.command {
            guard pending.target.id == target.id && pending.target.kind == target.kind else {
                throw MarinaError.message("Retry the previous unsent check-in first; its result is not confirmed.")
            }
            command = pending
        } else { command = CheckInCommand(target: target, instant: time) }
        try write(PendingCommandFile(command: command), to: "pending-command.json")
        cache.command = command; cache.message = "Saving…"; try write(cache, to: "schedule.json")
        do {
            try await MarinaAPI(token: connection().token).send(command)
            try write(PendingCommandFile(command: nil), to: "pending-command.json")
            cache.command = nil; cache.message = "Saved"; try write(cache, to: "schedule.json")
            if let fresh = try? await refresh() { await NativeNotifications.schedule(fresh) }
        } catch {
            if case MarinaError.server(let status, _) = error, [400,401,403,404,409,422].contains(status) {
                cache.command = nil; try? write(PendingCommandFile(command: nil), to: "pending-command.json")
            }
            cache.message = error.localizedDescription; try? write(cache, to: "schedule.json")
            WidgetCenter.shared.reloadAllTimelines(); throw error
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
