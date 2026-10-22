import Foundation

public struct StudySegment: Codable, Equatable, Sendable {
    public var start: String
    public var end: String
    public init(start: String, end: String) { self.start = start; self.end = end }
}

public enum StudyState: Equatable, Sendable, Codable {
    case running(since: String, checkpointAt: String, lastActivityAt: String, confirmedAt: String)
    case paused(reason: String)
    case completed

    public var kind: String {
        switch self { case .running: return "running"; case .paused: return "paused"; case .completed: return "completed" }
    }
    public var reason: String? { if case .paused(let reason) = self { return reason }; return nil }
    private enum Keys: String, CodingKey { case kind, since, checkpointAt, lastActivityAt, confirmedAt, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "running": self = .running(since: try c.decode(String.self, forKey: .since), checkpointAt: try c.decode(String.self, forKey: .checkpointAt), lastActivityAt: try c.decode(String.self, forKey: .lastActivityAt), confirmedAt: try c.decode(String.self, forKey: .confirmedAt))
        case "paused": self = .paused(reason: try c.decode(String.self, forKey: .reason))
        case "completed": self = .completed
        default: throw CentreError.invalid("Unknown study timer state.")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(kind, forKey: .kind)
        switch self {
        case let .running(since, checkpoint, activity, confirmed):
            try c.encode(since, forKey: .since); try c.encode(checkpoint, forKey: .checkpointAt)
            try c.encode(activity, forKey: .lastActivityAt); try c.encode(confirmed, forKey: .confirmedAt)
        case .paused(let reason): try c.encode(reason, forKey: .reason)
        case .completed: break
        }
    }
}

public struct StudySession: Codable, Equatable, Identifiable, Sendable {
    public var schemaVersion: Int
    public var id: String
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String
    public var deletedAt: String?
    public var source: String
    public var subjectId: String?
    public var taskId: String?
    public var title: String
    public var notes: String
    public var timeZone: String
    public var segments: [StudySegment]
    public var state: StudyState
    public init(schemaVersion: Int = 1, id: String = UUID().uuidString.lowercased(), revision: Int = 1, createdAt: String, updatedAt: String, deletedAt: String? = nil, source: String, subjectId: String? = nil, taskId: String? = nil, title: String, notes: String = "", timeZone: String, segments: [StudySegment] = [], state: StudyState) {
        self.schemaVersion = schemaVersion; self.id = id; self.revision = revision
        self.createdAt = createdAt; self.updatedAt = updatedAt; self.deletedAt = deletedAt
        self.source = source; self.subjectId = subjectId; self.taskId = taskId
        self.title = title; self.notes = notes; self.timeZone = timeZone; self.segments = segments; self.state = state
    }
    private enum CodingKeys: String, CodingKey { case schemaVersion, id, revision, createdAt, updatedAt, deletedAt, source, subjectId, taskId, title, notes, timeZone, segments, state }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schemaVersion, forKey: .schemaVersion); try c.encode(id, forKey: .id); try c.encode(revision, forKey: .revision)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(updatedAt, forKey: .updatedAt); try c.encode(deletedAt, forKey: .deletedAt)
        try c.encode(source, forKey: .source); try c.encode(subjectId, forKey: .subjectId); try c.encode(taskId, forKey: .taskId)
        try c.encode(title, forKey: .title); try c.encode(notes, forKey: .notes); try c.encode(timeZone, forKey: .timeZone)
        try c.encode(segments, forKey: .segments); try c.encode(state, forKey: .state)
    }
}

public struct WeeklyStudyGoal: Codable, Equatable, Identifiable, Sendable {
    public var schemaVersion: Int
    public var id: String
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String
    public var deletedAt: String?
    public var weekStart: String
    public var timeZone: String
    public var targetMinutes: Int
    public init(schemaVersion: Int = 1, id: String = UUID().uuidString.lowercased(), revision: Int = 1, createdAt: String, updatedAt: String, deletedAt: String? = nil, weekStart: String, timeZone: String, targetMinutes: Int) {
        self.schemaVersion = schemaVersion; self.id = id; self.revision = revision; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.weekStart = weekStart; self.timeZone = timeZone; self.targetMinutes = targetMinutes
    }
    private enum CodingKeys: String, CodingKey { case schemaVersion, id, revision, createdAt, updatedAt, deletedAt, weekStart, timeZone, targetMinutes }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schemaVersion, forKey: .schemaVersion); try c.encode(id, forKey: .id); try c.encode(revision, forKey: .revision)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(updatedAt, forKey: .updatedAt); try c.encode(deletedAt, forKey: .deletedAt)
        try c.encode(weekStart, forKey: .weekStart); try c.encode(timeZone, forKey: .timeZone); try c.encode(targetMinutes, forKey: .targetMinutes)
    }
}

public enum StudyRules {
    public static let heartbeatInterval: TimeInterval = 15
    public static let leaseInterval: TimeInterval = 45
    public static let idleInterval: TimeInterval = 600
    public static let checkInInterval: TimeInterval = 3600

    private static func zoneCalendar(_ zone: String) throws -> Calendar {
        let aliases: Set<String> = ["UTC", "UCT", "Universal", "Zulu", "Greenwich", "GMT0", "GMT+0", "GMT-0", "CET", "EET", "EST", "MST", "HST", "MET", "WET", "CST6CDT", "EST5EDT", "MST7MDT", "PST8PDT", "Cuba", "Egypt", "Eire", "GB", "GB-Eire", "Hongkong", "Iceland", "Iran", "Israel", "Jamaica", "Japan", "Kwajalein", "Libya", "Navajo", "NZ", "NZ-CHAT", "Poland", "Portugal", "PRC", "ROC", "ROK", "Singapore", "Turkey", "W-SU"]
        guard zone.count <= 100, let timeZone = TimeZone(identifier: zone),
              zone.contains("/") || TimeZone.knownTimeZoneIdentifiers.contains(zone) || aliases.contains(zone) else { throw CentreError.invalid("Choose a valid IANA time zone.") }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone; calendar.firstWeekday = 2
        return calendar
    }
    private static func instant(_ value: String) throws -> Date {
        guard value.hasSuffix("Z"), value.contains("T") else { throw CentreError.invalid("Use a valid UTC instant.") }
        return try Clock.date(value)
    }
    private static func running(_ now: Date) -> StudyState {
        let stamp = Clock.iso(now)
        return .running(since: stamp, checkpointAt: stamp, lastActivityAt: stamp, confirmedAt: stamp)
    }
    private static func limit(_ session: StudySession, now: Date) throws -> (end: Date, reason: String?) {
        guard case let .running(_, checkpoint, activity, confirmed) = session.state else { return (now, nil) }
        let checkpointDate = try instant(checkpoint)
        if now < checkpointDate { return (checkpointDate, "clock") }
        let idle = try instant(activity).addingTimeInterval(idleInterval)
        let checkIn = try instant(confirmed).addingTimeInterval(checkInInterval)
        let lease = now.timeIntervalSince(checkpointDate) > leaseInterval
        let end = min(now, idle, checkIn, lease ? checkpointDate : now)
        return (end, lease && end == checkpointDate ? "recovery" : end == idle ? "idle" : end == checkIn ? "check-in" : nil)
    }
    private static func close(_ session: StudySession, end: Date, state: StudyState) throws -> StudySession {
        var next = session
        if case let .running(since, _, _, _) = session.state, end > (try instant(since)) {
            next.segments.append(StudySegment(start: since, end: Clock.iso(end)))
        }
        next.state = state
        return next
    }
    private static func changed(_ session: StudySession, now: Date) -> StudySession {
        var next = session; next.revision += 1; next.updatedAt = Clock.iso(now); return next
    }
    private static func requireTimer(_ session: StudySession) throws {
        guard session.source == "timer", session.deletedAt == nil, session.state != .completed else { throw CentreError.invalid("Choose an unfinished timer.") }
    }
    public static func start(id: String = UUID().uuidString.lowercased(), title: String, subjectId: String?, taskId: String? = nil, timeZone: String, now: Date) throws -> StudySession {
        let stamp = Clock.iso(now)
        let result = StudySession(id: id, createdAt: stamp, updatedAt: stamp, source: "timer", subjectId: subjectId, taskId: taskId, title: title.trimmingCharacters(in: .whitespacesAndNewlines), timeZone: timeZone, state: running(now))
        try validate(result, others: [], now: now); return result
    }
    public static func manual(id: String = UUID().uuidString.lowercased(), title: String, subjectId: String?, taskId: String? = nil, timeZone: String, start: Date, end: Date, now: Date) throws -> StudySession {
        let stamp = Clock.iso(now)
        let result = StudySession(id: id, createdAt: stamp, updatedAt: stamp, source: "manual", subjectId: subjectId, taskId: taskId, title: title.trimmingCharacters(in: .whitespacesAndNewlines), timeZone: timeZone, segments: [.init(start: Clock.iso(start), end: Clock.iso(end))], state: .completed)
        try validate(result, others: [], now: now); return result
    }
    public static func recover(_ session: StudySession, now: Date, restart: Bool = false) throws -> StudySession {
        guard case let .running(_, checkpoint, _, _) = session.state else { return session }
        let bound = restart ? (end: try instant(checkpoint), reason: Optional("recovery")) : try limit(session, now: now)
        guard let reason = bound.reason else { return session }
        return changed(try close(session, end: bound.end, state: .paused(reason: reason)), now: now)
    }
    public static func heartbeat(_ session: StudySession, now: Date, activity: Bool = false, confirm: Bool = false) throws -> StudySession {
        try requireTimer(session)
        let recovered = try recover(session, now: now)
        if recovered != session { return recovered }
        guard case let .running(since, _, lastActivity, confirmed) = session.state else { throw CentreError.invalid("Resume this paused timer first.") }
        var next = session; let stamp = Clock.iso(now)
        next.state = .running(since: since, checkpointAt: stamp, lastActivityAt: activity || confirm ? stamp : lastActivity, confirmedAt: confirm ? stamp : confirmed)
        return changed(next, now: now)
    }
    public static func pause(_ session: StudySession, now: Date, recovery: Bool = false) throws -> StudySession {
        try requireTimer(session)
        let recovered = try recover(session, now: now, restart: recovery)
        if recovered != session { return recovered }
        guard case .running = session.state else { throw CentreError.invalid("This timer is already paused.") }
        return changed(try close(session, end: now, state: .paused(reason: "user")), now: now)
    }
    public static func resume(_ session: StudySession, now: Date) throws -> StudySession {
        try requireTimer(session)
        let recovered = try recover(session, now: now)
        if recovered != session { return recovered }
        guard case .paused = session.state else { throw CentreError.invalid("This timer is already running.") }
        guard session.segments.last.map({ (try? instant($0.end)) ?? now }) ?? now <= now else { throw CentreError.invalid("The clock is earlier than this timer's last interval.") }
        var next = session; next.state = running(now); return changed(next, now: now)
    }
    public static func stop(_ session: StudySession, now: Date) throws -> StudySession {
        try requireTimer(session)
        let recovered = try recover(session, now: now)
        let next = try close(recovered, end: now, state: .completed)
        return changed(next, now: now)
    }
    public static func sessionSegments(_ session: StudySession, now: Date) throws -> [StudySegment] {
        guard session.deletedAt == nil else { return [] }
        guard case .running = session.state else { return session.segments }
        return try close(session, end: limit(session, now: now).end, state: .completed).segments
    }
    public static func validate(_ session: StudySession, others: [StudySession] = [], now: Date, previous: StudySession? = nil) throws {
        guard session.schemaVersion == 1, UUID(uuidString: session.id) != nil, session.revision > 0,
              ["timer", "manual"].contains(session.source), !session.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              session.title.utf16.count <= 200, session.notes.utf16.count <= 10000, session.segments.count <= 5000 else { throw CentreError.invalid("Invalid study entry.") }
        for tag in [session.subjectId, session.taskId].compactMap({ $0 }) {
            guard !tag.isEmpty, tag.utf16.count <= 200 else { throw CentreError.invalid("Invalid subject or task ID.") }
        }
        _ = try zoneCalendar(session.timeZone); _ = try instant(session.createdAt); _ = try instant(session.updatedAt)
        if let deleted = session.deletedAt { _ = try instant(deleted); guard session.state == .completed else { throw CentreError.invalid("Finish a timer before deleting it.") } }
        var priorEnd: Date?
        for segment in session.segments {
            let start = try instant(segment.start), end = try instant(segment.end)
            guard end > start, priorEnd.map({ start >= $0 }) ?? true else { throw CentreError.invalid("Study intervals must be positive, chronological and cannot overlap.") }
            guard session.source != "manual" || end <= now else { throw CentreError.invalid("Actual study cannot be in the future.") }
            priorEnd = end
        }
        if session.source == "manual", session.state != .completed || session.segments.isEmpty { throw CentreError.invalid("Manual study needs completed intervals.") }
        switch session.state {
        case let .running(since, checkpoint, activity, confirmed):
            let a = try instant(since), b = try instant(checkpoint), c = try instant(activity), d = try instant(confirmed)
            guard b >= a, c >= a, c <= b, d >= a, d <= b, priorEnd.map({ $0 <= a }) ?? true else { throw CentreError.invalid("Invalid running timer checkpoint.") }
        case .paused(let reason): guard ["user", "idle", "recovery", "check-in", "clock"].contains(reason) else { throw CentreError.invalid("Invalid pause reason.") }
        case .completed: break
        }
        guard session.deletedAt == nil else { return }
        var intervals = try sessionSegments(session, now: now)
        var starting = session.state.kind == "running"
        var resuming = false
        if let previous, previous.source == "timer", previous.state != .completed, session.source == "timer" {
            switch session.state {
            case .completed, .paused:
                // Finishing or pausing never adds study after now and must remain possible for imported overlaps.
                return
            case let .running(since, checkpoint, _, _):
                starting = false
                if case let .running(_, oldCheckpoint, _, _) = previous.state {
                    let start = try instant(oldCheckpoint), end = try instant(checkpoint)
                    intervals = end > start ? [.init(start: oldCheckpoint, end: checkpoint)] : []
                } else {
                    resuming = true
                    intervals = [.init(start: since, end: Clock.iso(try instant(since).addingTimeInterval(0.001)))]
                }
            }
        } else if session.source == "timer", case .paused = session.state {
            // More than one imported timer may be paused; their histories may overlap.
            return
        }
        if starting, case let .running(since, _, _, _) = session.state {
            intervals.append(.init(start: since, end: Clock.iso(try instant(since).addingTimeInterval(0.001))))
        }
        for other in others where other.id != session.id && other.deletedAt == nil {
            if starting && other.state != .completed { throw CentreError.invalid("Stop the current timer before starting another.") }
            if resuming && other.state.kind == "running" { throw CentreError.invalid("Pause or stop the other running timer first.") }
            let otherIntervals = try sessionSegments(other, now: now)
            for a in intervals {
                for b in otherIntervals where try instant(a.start) < instant(b.end) && instant(b.start) < instant(a.end) {
                    throw CentreError.invalid("This time overlaps another study entry.")
                }
            }
        }
    }
    public static func weekStart(at: Date, timeZone: String) throws -> String {
        let calendar = try zoneCalendar(timeZone)
        let day = calendar.startOfDay(for: at)
        let days = (calendar.component(.weekday, from: day) + 5) % 7
        guard let monday = calendar.date(byAdding: .day, value: -days, to: day) else { throw CentreError.invalid("Invalid study week.") }
        let c = calendar.dateComponents([.year, .month, .day], from: monday)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
    public static func weeklyDuration(_ sessions: [StudySession], at: Date, timeZone: String) throws -> TimeInterval {
        let calendar = try zoneCalendar(timeZone)
        let week = try weekStart(at: at, timeZone: timeZone)
        let parts = week.split(separator: "-").compactMap { Int($0) }
        guard let start = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])), let end = calendar.date(byAdding: .day, value: 7, to: start) else { throw CentreError.invalid("Invalid study week.") }
        var intervals: [(Date, Date)] = []
        for session in sessions {
            for segment in try sessionSegments(session, now: at) {
                let a = max(start, try instant(segment.start)), b = min(end, try instant(segment.end))
                if b > a { intervals.append((a, b)) }
            }
        }
        intervals.sort { $0.0 < $1.0 }
        var total: TimeInterval = 0
        var current: (Date, Date)?
        for interval in intervals {
            if let previous = current, interval.0 <= previous.1 { current = (previous.0, max(previous.1, interval.1)) }
            else { if let previous = current { total += previous.1.timeIntervalSince(previous.0) }; current = interval }
        }
        if let previous = current { total += previous.1.timeIntervalSince(previous.0) }
        return total
    }
    public static func goal(minutes: Int, at: Date, timeZone: String, existing: WeeklyStudyGoal? = nil) throws -> WeeklyStudyGoal {
        guard (1...10080).contains(minutes) else { throw CentreError.invalid("Choose a weekly aim between 1 and 10080 minutes.") }
        let week = try weekStart(at: at, timeZone: timeZone), stamp = Clock.iso(at)
        if var existing {
            guard existing.weekStart == week, existing.timeZone == timeZone, existing.deletedAt == nil else { throw CentreError.invalid("Choose this week's aim.") }
            existing.targetMinutes = minutes; existing.updatedAt = stamp; existing.revision += 1; return existing
        }
        return WeeklyStudyGoal(createdAt: stamp, updatedAt: stamp, weekStart: week, timeZone: timeZone, targetMinutes: minutes)
    }
}
