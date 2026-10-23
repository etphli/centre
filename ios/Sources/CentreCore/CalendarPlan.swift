import Foundation

public enum CalendarPlan {
    private static func calendar(timeZone: String) throws -> Calendar {
        let aliases: Set<String> = ["UTC", "UCT", "Universal", "Zulu", "Greenwich", "GMT0", "GMT+0", "GMT-0", "CET", "EET", "EST", "MST", "HST", "MET", "WET", "CST6CDT", "EST5EDT", "MST7MDT", "PST8PDT", "Cuba", "Egypt", "Eire", "GB", "GB-Eire", "Hongkong", "Iceland", "Iran", "Israel", "Jamaica", "Japan", "Kwajalein", "Libya", "Navajo", "NZ", "NZ-CHAT", "Poland", "Portugal", "PRC", "ROC", "ROK", "Singapore", "Turkey", "W-SU"]
        guard timeZone.utf16.count <= 100, let zone = TimeZone(identifier: timeZone),
              timeZone.contains("/") || TimeZone.knownTimeZoneIdentifiers.contains(timeZone) || aliases.contains(timeZone) else {
            throw CentreError.invalid("Choose a valid IANA time zone.")
        }
        var result = Calendar(identifier: .gregorian)
        result.timeZone = zone
        return result
    }

    public static func localStart(date: String, time: String, timeZone: String) throws -> Date {
        guard date.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil,
              time.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,9})?)?$", options: .regularExpression) != nil else {
            throw CentreError.invalid("Choose a valid local date and time.")
        }
        let calendar = try calendar(timeZone: timeZone)
        let day = date.split(separator: "-").compactMap { Int($0) }
        let clock = time.split(separator: ":")
        let seconds = clock.count == 3 ? String(clock[2]).split(separator: ".") : []
        let second = seconds.first.flatMap { Int($0) } ?? 0
        let fraction = seconds.count == 2 ? Double("0." + seconds[1]) ?? 0 : 0
        let components = DateComponents(year: day[0], month: day[1], day: day[2], hour: Int(clock[0]), minute: Int(clock[1]), second: second)
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
        guard day[0] > 0, let anchor = utc.date(from: DateComponents(year: day[0], month: day[1], day: day[2])),
              utc.dateComponents([.year, .month, .day], from: anchor) == DateComponents(year: day[0], month: day[1], day: day[2]) else {
            throw CentreError.invalid("Choose a valid local date.")
        }
        let before = anchor.addingTimeInterval(-172800)
        guard let first = calendar.nextDate(after: before, matching: components, matchingPolicy: .strict, repeatedTimePolicy: .first),
              let last = calendar.nextDate(after: before, matching: components, matchingPolicy: .strict, repeatedTimePolicy: .last) else {
            throw CentreError.invalid("This local time does not exist because the clocks change. Choose another time.")
        }
        guard first == last else {
            throw CentreError.invalid("This local time occurs twice because the clocks change. Choose another time.")
        }
        return first.addingTimeInterval(fraction)
    }

    public static func validateMetadata(title: String, durationMinutes: Int) throws {
        let title=title.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 200 else { throw CentreError.invalid("Use a planned session title between 1 and 200 characters.") }
        guard (5...720).contains(durationMinutes) else { throw CentreError.invalid("Choose a planned duration between 5 and 720 minutes.") }
    }

    // Check only fields whose rejection is provable locally. Existing journal files
    // remain readable, including invalid commands saved by older app versions.
    public static func validateCommandMetadata(_ command: ConnectorCommand) throws {
        let value=command.method == "PATCH" ? command.body["patch"] : command.body["data"]
        guard case .object(let fields) = value else { return }
        if let raw=fields["title"] {
            guard let title=raw.string else { throw CentreError.invalid("Use a text session title.") }
            try validateMetadata(title:title,durationMinutes:60)
        }
        if let raw=fields["subjectId"], raw != .null {
            guard let subject=raw.string, subject.utf16.count <= 200 else { throw CentreError.invalid("Use a valid calendar subject identifier.") }
        }
        if let raw=fields["notes"] {
            guard let notes=raw.string, notes.utf16.count <= 20000 else { throw CentreError.invalid("Use calendar notes up to 20000 characters.") }
        }
        if let raw=fields["plannedDurationMinutes"] {
            guard let duration=raw.int else { throw CentreError.invalid("Choose a whole number of planned minutes.") }
            try validateMetadata(title:"Session",durationMinutes:duration)
        }
    }

    public static func create(title: String, start: Date, timeZone: String, durationMinutes: Int = 60, subjectId: String? = nil, now: Date = Date()) throws -> JSONValue {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        try validateMetadata(title:title,durationMinutes:durationMinutes)
        guard subjectId.map({$0.utf16.count <= 200}) != false else { throw CentreError.invalid("Use a valid calendar subject identifier.") }
        guard start.timeIntervalSince1970.isFinite, now.timeIntervalSince1970.isFinite else { throw CentreError.invalid("Choose a valid start time.") }
        let calendar = try calendar(timeZone: timeZone)
        let startAt = Clock.iso(start), stamp = Clock.iso(now)
        let storedStart = try Clock.date(startAt)
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let date = formatter.string(from: storedStart)
        formatter.dateFormat = "HH:mm:ss.SSS"
        let preciseTime = formatter.string(from: storedStart)
        let time = preciseTime.hasSuffix(".000") ? String(preciseTime.dropLast(4)) : preciseTime
        _ = try localStart(date: date, time: time, timeZone: timeZone)
        return .object([
            "schemaVersion": .number(1), "id": .string(UUID().uuidString.lowercased()), "revision": .number(1),
            "createdAt": .string(stamp), "updatedAt": .string(stamp), "deletedAt": .null,
            "origin": .string("centre"), "kind": .string("session"), "title": .string(title),
            "date": .string(date), "time": .string(time), "timeZone": .string(timeZone), "startAt": .string(startAt),
            "plannedDurationMinutes": .number(Double(durationMinutes)), "subjectId": subjectId.map(JSONValue.string) ?? .null,
            "notes": .string(""), "completedAt": .null, "organatoId": .null, "organatoVersion": .null
        ])
    }
}
