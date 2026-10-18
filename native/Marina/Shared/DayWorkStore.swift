import Foundation
import MarinaCore
import WidgetKit
import Darwin

struct DayWorkCache: Codable {
    var context: DayWorkContext?
    var message: String?
    var offset: Int = 0
}
private struct PendingWork: Codable { let command: DayWorkCommand? }
enum DayWorkStore {
    static let kind = "MarinaDayWork"
    static func cache() -> DayWorkCache { (try? SharedStore.read("day-work.json", as: DayWorkCache.self)) ?? DayWorkCache() }
    static func pending() -> DayWorkCommand? { (try? SharedStore.read("pending-work.json", as: PendingWork.self))?.command }
    static func refresh(available: Bool = false) async throws -> DayWorkContext {
        let value = try await MarinaAPI(token: SharedStore.connection().token).workContext(available: available)
        var cache = cache(); cache.context = value
        try SharedStore.write(cache, to: "day-work.json"); return value
    }
    static func message(_ text: String?) {
        var cache = cache(); cache.message = text; try? SharedStore.write(cache, to: "day-work.json")
        WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
    static func submit(_ proposed: DayWorkCommand) async throws {
        // Same cross-process lock as schedule check-in; uncertain saves block
        // both surfaces until the original command has been retried.
        let fd = open(try SharedStore.container().appendingPathComponent("checkin.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw MarinaError.message("Timer storage is unavailable.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw MarinaError.message("Another save is in progress. Try again.") }
        defer { flock(fd, LOCK_UN); close(fd) }
        guard SharedStore.cache().command == nil else { throw MarinaError.message("Retry your unconfirmed calendar check-in first.") }
        let command = pending() ?? proposed
        guard command.commandID == proposed.commandID else { throw MarinaError.message("Retry the previous timer save first.") }
        try SharedStore.write(PendingWork(command: command), to: "pending-work.json")
        message("Saving…")
        do {
            try await MarinaAPI(token: SharedStore.connection().token).sendWork(command)
            try SharedStore.write(PendingWork(command: nil), to: "pending-work.json")
            message(nil)
            _ = try? await refresh()
            _ = try? await SharedStore.refresh()
        } catch {
            if case MarinaError.server(let status, _) = error, [400,401,403,404,409,422].contains(status) {
                try? SharedStore.write(PendingWork(command: nil), to: "pending-work.json")
                _ = try? await refresh()
            }
            message(error.localizedDescription); throw error
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
