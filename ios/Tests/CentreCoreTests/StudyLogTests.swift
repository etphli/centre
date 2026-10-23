import Foundation
import XCTest
@testable import CentreCore

final class StudyLogTests: XCTestCase {
    func testImportedPausedRecordNeverDisplacesRunningTimer() throws {
        let now=try Clock.date("2026-10-22T00:00:00.000Z")
        let running=try StudyRules.start(title:"Actual study",subjectId:nil,timeZone:"Australia/Sydney",now:now)
        let imported=try StudyRules.start(title:"Imported",subjectId:nil,timeZone:"Australia/Sydney",now:now.addingTimeInterval(-3600))
        let paused=try StudyRules.recover(imported,now:now,restart:true)
        XCTAssertEqual(StudyRules.preferredSession([paused,running])?.id,running.id)
        let checkpoint=try StudyRules.heartbeat(XCTUnwrap(StudyRules.preferredSession([paused,running])),now:now.addingTimeInterval(15),activity:true)
        XCTAssertEqual(try StudyRules.weeklyDuration([checkpoint],at:now.addingTimeInterval(15),timeZone:"Australia/Sydney"),15)
    }
    private func date(_ value: String) throws -> Date { try Clock.date(value) }
    private func timer(at now: Date) throws -> StudySession {
        try StudyRules.start(title: "Revision", subjectId: "math", timeZone: "Australia/Sydney", now: now)
    }
    private func manual(_ start: String, _ end: String, now: Date) throws -> StudySession {
        try StudyRules.manual(title: "Revision", subjectId: nil, timeZone: "Australia/Sydney", start: date(start), end: date(end), now: now)
    }

    func testCanonicalJSONAndRecovery() throws {
        let json = #"{"schemaVersion":1,"id":"cb777188-d7d6-40d9-9056-390bfb0d5811","revision":2,"createdAt":"2026-10-22T00:00:00.000Z","updatedAt":"2026-10-22T00:00:15.000Z","deletedAt":null,"source":"timer","subjectId":null,"taskId":null,"title":"Import this timer paused","notes":"Closed app and second device never count beyond checkpoint.","timeZone":"Australia/Sydney","segments":[],"state":{"kind":"running","since":"2026-10-22T00:00:00.000Z","checkpointAt":"2026-10-22T00:00:15.000Z","lastActivityAt":"2026-10-22T00:00:15.000Z","confirmedAt":"2026-10-22T00:00:00.000Z"}}"#
        let original = try JSONDecoder().decode(StudySession.self, from: Data(json.utf8))
        XCTAssertNil(original.targetMinutes, "Legacy timer records remain elapsed stopwatches")
        let encoded = try JSONEncoder().encode(original)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertTrue(fields["deletedAt"] is NSNull)
        XCTAssertTrue(fields["subjectId"] is NSNull)
        XCTAssertTrue(fields["taskId"] is NSNull)
        XCTAssertNil(fields["targetMinutes"], "Legacy records omit the optional countdown field")
        XCTAssertEqual(try JSONDecoder().decode(StudySession.self, from: encoded), original)
        let now = try date("2026-10-22T01:00:00.000Z")
        let recovered = try StudyRules.recover(original, now: now, restart: true)
        XCTAssertEqual(recovered.state, .paused(reason: "recovery"))
        XCTAssertEqual(recovered.revision, 3)
        XCTAssertEqual(recovered.segments, [.init(start: "2026-10-22T00:00:00.000Z", end: "2026-10-22T00:00:15.000Z")])
        XCTAssertEqual(try StudyRules.recover(recovered, now: now, restart: true), recovered)
        XCTAssertEqual(try StudyRules.weeklyDuration([recovered], at: now, timeZone: "Australia/Sydney"), 15)
        let freshImport = try timer(at: now)
        XCTAssertEqual(try StudyRules.recover(freshImport, now: now.addingTimeInterval(1), restart: true).state, .paused(reason: "recovery"))
    }

    func testCanonicalOvernightWeekAndOverlapUnion() throws {
        let now = try date("2026-10-22T01:00:00.000Z")
        var session = try manual("2026-10-18T12:00:00.000Z", "2026-10-18T12:30:00.000Z", now: now)
        session.segments.append(.init(start: "2026-10-18T13:00:00.000Z", end: "2026-10-18T14:00:00.000Z"))
        XCTAssertEqual(try StudyRules.weeklyDuration([session], at: date("2026-10-18T12:00:00.000Z"), timeZone: "Australia/Sydney"), 1800)
        XCTAssertEqual(try StudyRules.weeklyDuration([session], at: now, timeZone: "Australia/Sydney"), 3600)
        let duplicate = try manual("2026-10-18T13:30:00.000Z", "2026-10-18T14:30:00.000Z", now: now)
        XCTAssertEqual(try StudyRules.weeklyDuration([session, duplicate], at: now, timeZone: "Australia/Sydney"), 5400)
        var tombstone = duplicate; tombstone.deletedAt = Clock.iso(now)
        XCTAssertEqual(try StudyRules.weeklyDuration([session, tombstone], at: now, timeZone: "Australia/Sydney"), 3600)
        XCTAssertEqual(try StudyRules.weekStart(at: date("2026-10-18T12:59:59.000Z"), timeZone: "Australia/Sydney"), "2026-10-12")
        XCTAssertEqual(try StudyRules.weekStart(at: date("2026-10-18T13:00:00.000Z"), timeZone: "Australia/Sydney"), "2026-10-19")
    }

    func testDstUsesElapsedSeconds() throws {
        let now = try date("2026-10-22T01:00:00.000Z")
        let shortDay = try manual("2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z", now: now)
        let longDay = try manual("2026-04-04T13:00:00.000Z", "2026-04-05T14:00:00.000Z", now: now)
        XCTAssertEqual(try StudyRules.weeklyDuration([shortDay], at: date("2026-10-04T12:00:00.000Z"), timeZone: "Australia/Sydney"), 82800)
        XCTAssertEqual(try StudyRules.weeklyDuration([longDay], at: date("2026-04-05T12:00:00.000Z"), timeZone: "Australia/Sydney"), 90000)
    }

    func testCheckpointLeaseAndBackgroundNeverCreditClosedTime() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        let started = try timer(at: now)
        let checkpoint = try StudyRules.heartbeat(started, now: now.addingTimeInterval(15), activity: true)
        XCTAssertEqual(checkpoint.revision, 2)
        XCTAssertEqual(try StudyRules.recover(checkpoint, now: now.addingTimeInterval(60)), checkpoint)
        let expired = try StudyRules.heartbeat(checkpoint, now: now.addingTimeInterval(60.001), activity: true)
        XCTAssertEqual(expired.state, .paused(reason: "recovery"))
        XCTAssertEqual(expired.segments.last?.end, "2026-10-22T00:00:15.000Z")
        XCTAssertEqual(expired.revision, 3)
        let background = try StudyRules.pause(checkpoint, now: now.addingTimeInterval(20), recovery: true)
        XCTAssertEqual(background.state, .paused(reason: "recovery"))
        XCTAssertEqual(background.segments.last?.end, "2026-10-22T00:00:15.000Z")
        let resumed = try StudyRules.resume(expired, now: now.addingTimeInterval(3600))
        let stopped = try StudyRules.stop(resumed, now: now.addingTimeInterval(3615))
        XCTAssertEqual(try StudyRules.weeklyDuration([stopped], at: now.addingTimeInterval(4000), timeZone: "Australia/Sydney"), 30)
    }

    func testCountdownValidationAndCanonicalEncoding() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        let metadataFree = try StudyRules.start(timeZone: "Australia/Sydney", now: now)
        XCTAssertEqual(metadataFree.title, "Study session")
        XCTAssertNil(metadataFree.subjectId)
        let timer = try StudyRules.start(title: "  ", subjectId: nil, targetMinutes: 30, timeZone: "Australia/Sydney", now: now)
        XCTAssertEqual(timer.title, "Study session")
        XCTAssertEqual(timer.targetMinutes, 30)
        let encoded = try JSONEncoder().encode(timer)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(fields["targetMinutes"] as? Int, 30)
        XCTAssertEqual(try JSONDecoder().decode(StudySession.self, from: encoded), timer)

        for minutes in [0, 4, 6, 1441, 1445] {
            var invalid = timer
            invalid.targetMinutes = minutes
            XCTAssertThrowsError(try StudyRules.validate(invalid, now: now), "\(minutes) minutes must be rejected")
        }
        var manualWithTarget = try manual("2026-10-22T00:00:00.000Z", "2026-10-22T00:01:00.000Z", now: now)
        manualWithTarget.targetMinutes = 5
        XCTAssertThrowsError(try StudyRules.validate(manualWithTarget, now: now), "Only timer records can have a target duration")

        let minimum = try StudyRules.start(title: "Minimum", subjectId: nil, targetMinutes: 5, timeZone: "Australia/Sydney", now: now)
        let maximum = try StudyRules.start(title: "Maximum", subjectId: nil, targetMinutes: 1440, timeZone: "Australia/Sydney", now: now)
        XCTAssertEqual(minimum.targetMinutes, 5)
        XCTAssertEqual(maximum.targetMinutes, 1440)
    }

    func testCountdownExcludesPausedTimeAndSurvivesCheckpointRecovery() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        var started = try StudyRules.start(title: "Revision", subjectId: nil, targetMinutes: 30, timeZone: "Australia/Sydney", now: now)
        for second in stride(from: 15, through: 285, by: 15) {
            started = try StudyRules.heartbeat(started, now: now.addingTimeInterval(Double(second)), activity: true)
        }
        let paused = try StudyRules.pause(started, now: now.addingTimeInterval(300))
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(paused, now: now.addingTimeInterval(300))), 1500)
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(paused, now: now.addingTimeInterval(3600))), 1500)

        let resumed = try StudyRules.resume(paused, now: now.addingTimeInterval(3600))
        let checkpoint = try StudyRules.heartbeat(resumed, now: now.addingTimeInterval(3605), activity: true)
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(checkpoint, now: now.addingTimeInterval(3605))), 1495)
        let recovered = try StudyRules.recover(checkpoint, now: now.addingTimeInterval(4000), restart: true)
        XCTAssertEqual(recovered.state, .paused(reason: "recovery"))
        XCTAssertEqual(recovered.targetMinutes, 30)
        XCTAssertEqual(recovered.segments.last?.end, "2026-10-22T01:00:05.000Z")
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(recovered, now: now.addingTimeInterval(4000))), 1495)
    }

    func testCountdownCompletesAtExactDeadlineAndEarlierPauseRulesStillWin() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        var countdown = try StudyRules.start(title: "Five minute timer", subjectId: nil, targetMinutes: 5, timeZone: "Australia/Sydney", now: now)
        for second in stride(from: 15, through: 285, by: 15) {
            countdown = try StudyRules.heartbeat(countdown, now: now.addingTimeInterval(Double(second)), activity: true)
        }
        countdown = try StudyRules.heartbeat(countdown, now: now.addingTimeInterval(305), activity: true)
        XCTAssertEqual(countdown.state, .completed)
        XCTAssertEqual(countdown.segments, [.init(start: Clock.iso(now), end: Clock.iso(now.addingTimeInterval(300)))])
        XCTAssertEqual(try StudyRules.elapsedSeconds(countdown, now: now.addingTimeInterval(305)), 300)
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(countdown, now: now.addingTimeInterval(305))), 0)

        var idle = try StudyRules.start(title: "Idle limit", subjectId: nil, targetMinutes: 30, timeZone: "Australia/Sydney", now: now)
        for second in stride(from: 15, through: 600, by: 15) {
            idle = try StudyRules.heartbeat(idle, now: now.addingTimeInterval(Double(second)))
        }
        XCTAssertEqual(idle.state, .paused(reason: "idle"))
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(idle, now: now.addingTimeInterval(600))), 1200)

        var checkIn = try StudyRules.start(title: "Hourly check-in", subjectId: nil, targetMinutes: 90, timeZone: "Australia/Sydney", now: now)
        for second in stride(from: 15, through: 3600, by: 15) {
            checkIn = try StudyRules.heartbeat(checkIn, now: now.addingTimeInterval(Double(second)), activity: true)
        }
        XCTAssertEqual(checkIn.state, .paused(reason: "check-in"))
        XCTAssertEqual(try XCTUnwrap(StudyRules.remainingSeconds(checkIn, now: now.addingTimeInterval(3600))), 1800)
    }

    func testIdleCheckInAndExplicitConfirmation() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        var idle = try timer(at: now)
        for second in stride(from: 15, through: 600, by: 15) {
            idle = try StudyRules.heartbeat(idle, now: now.addingTimeInterval(Double(second)))
        }
        XCTAssertEqual(idle.state, .paused(reason: "idle"))
        XCTAssertEqual(idle.segments.last?.end, "2026-10-22T00:10:00.000Z")
        var active = try timer(at: now)
        for second in stride(from: 15, through: 3600, by: 15) {
            active = try StudyRules.heartbeat(active, now: now.addingTimeInterval(Double(second)), activity: true)
        }
        XCTAssertEqual(active.state, .paused(reason: "check-in"))
        XCTAssertEqual(active.segments.last?.end, "2026-10-22T01:00:00.000Z")
        var confirmed = try timer(at: now)
        for second in stride(from: 15, through: 3600, by: 15) {
            confirmed = try StudyRules.heartbeat(confirmed, now: now.addingTimeInterval(Double(second)), activity: true, confirm: second == 3585)
        }
        XCTAssertEqual(confirmed.state.kind, "running")
        XCTAssertEqual(try StudyRules.sessionSegments(confirmed, now: now.addingTimeInterval(3600)).last?.end, "2026-10-22T01:00:00.000Z")
    }

    func testClockRollbackRetainsCheckpoint() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        let checkpoint = try StudyRules.heartbeat(timer(at: now), now: now.addingTimeInterval(15))
        let recovered = try StudyRules.recover(checkpoint, now: now.addingTimeInterval(10))
        XCTAssertEqual(recovered.state, .paused(reason: "clock"))
        XCTAssertEqual(recovered.segments.last?.end, "2026-10-22T00:00:15.000Z")
        XCTAssertThrowsError(try StudyRules.resume(recovered, now: now.addingTimeInterval(10))) { error in XCTAssertTrue(error is CentreError) }
    }

    func testValidationRejectsFutureOverlapsAndMultipleTimers() throws {
        let now = try date("2026-10-22T01:00:00.000Z")
        XCTAssertThrowsError(try manual("2026-10-22T00:00:00.000Z", "2026-10-22T02:00:00.000Z", now: now)) { error in XCTAssertTrue(error is CentreError) }
        XCTAssertThrowsError(try manual("2026-10-22T00:00:00.000Z", "2026-10-22T00:00:00.000Z", now: now)) { error in XCTAssertTrue(error is CentreError) }
        let first = try manual("2026-10-22T00:00:00.000Z", "2026-10-22T00:30:00.000Z", now: now)
        let overlap = try manual("2026-10-22T00:15:00.000Z", "2026-10-22T00:45:00.000Z", now: now)
        XCTAssertThrowsError(try StudyRules.validate(overlap, others: [first], now: now)) { error in XCTAssertTrue(error is CentreError) }
        let adjacent = try manual("2026-10-22T00:30:00.000Z", "2026-10-22T00:45:00.000Z", now: now)
        try StudyRules.validate(adjacent, others: [first], now: now)
        let running = try timer(at: now.addingTimeInterval(-15))
        let activeOverlap = try manual("2026-10-22T00:59:50.000Z", "2026-10-22T01:00:00.000Z", now: now)
        XCTAssertThrowsError(try StudyRules.validate(activeOverlap, others: [running], now: now)) { error in XCTAssertTrue(error is CentreError) }
        let paused = try StudyRules.pause(running, now: now)
        XCTAssertThrowsError(try StudyRules.validate(timer(at: now), others: [paused], now: now)) { error in XCTAssertTrue(error is CentreError) }
        var deleted = overlap; deleted.deletedAt = Clock.iso(now)
        try StudyRules.validate(first, others: [deleted], now: now)
        var invalid = first; invalid.timeZone = "Not/AZone"
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
        invalid = first; invalid.timeZone = "GMT+1100"
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
        invalid = first; invalid.timeZone = "PST"
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
        invalid = first; invalid.segments += first.segments
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
        invalid = running; invalid.deletedAt = Clock.iso(now)
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
        invalid = first; invalid.state = .paused(reason: "user")
        XCTAssertThrowsError(try StudyRules.validate(invalid, now: now)) { error in XCTAssertTrue(error is CentreError) }
    }

    func testImportedPausedTimersCanResumeAndAlwaysStopDespiteHistoricalOverlap() throws {
        let now = try date("2026-10-22T01:00:00.000Z")
        var first = try manual("2026-10-22T00:00:00.000Z", "2026-10-22T00:30:00.000Z", now: now)
        first.source = "timer"; first.state = .paused(reason: "recovery")
        var second = try manual("2026-10-22T00:15:00.000Z", "2026-10-22T00:45:00.000Z", now: now)
        second.source = "timer"; second.state = .paused(reason: "recovery")
        try StudyRules.validate(first, others: [second], now: now)
        try StudyRules.validate(second, others: [first], now: now)

        let resumed = try StudyRules.resume(first, now: now)
        try StudyRules.validate(resumed, others: [second], now: now, previous: first)
        let secondResumed = try StudyRules.resume(second, now: now)
        XCTAssertThrowsError(try StudyRules.validate(secondResumed, others: [resumed], now: now, previous: second))
        XCTAssertThrowsError(try StudyRules.validate(timer(at: now), others: [first, second], now: now))

        let later = now.addingTimeInterval(15)
        let checkpoint = try StudyRules.heartbeat(resumed, now: later, activity: true)
        try StudyRules.validate(checkpoint, others: [second], now: later, previous: resumed)
        let newOverlap = try manual("2026-10-22T01:00:05.000Z", "2026-10-22T01:00:10.000Z", now: later)
        XCTAssertThrowsError(try StudyRules.validate(checkpoint, others: [second, newOverlap], now: later, previous: resumed))

        let stopped = try StudyRules.stop(resumed, now: later)
        try StudyRules.validate(stopped, others: [second, newOverlap], now: later, previous: resumed)
        XCTAssertEqual(stopped.state, .completed)
        XCTAssertEqual(stopped.segments.last?.end, "2026-10-22T01:00:15.000Z")
        let secondStopped = try StudyRules.stop(second, now: later)
        try StudyRules.validate(secondStopped, others: [stopped], now: later, previous: second)
        XCTAssertEqual(secondStopped.segments, second.segments)
        XCTAssertEqual(try StudyRules.weeklyDuration([stopped, secondStopped], at: later, timeZone: "Australia/Sydney"), 2715)
    }

    func testWeeklyAimIsExplicitAndRevisesSameWeek() throws {
        let now = try date("2026-10-22T01:00:00.000Z")
        let goal = try StudyRules.goal(minutes: 600, at: now, timeZone: "Australia/Sydney")
        XCTAssertEqual(goal.weekStart, "2026-10-19")
        XCTAssertEqual(goal.revision, 1)
        let updated = try StudyRules.goal(minutes: 700, at: now.addingTimeInterval(15), timeZone: "Australia/Sydney", existing: goal)
        XCTAssertEqual(updated.id, goal.id)
        XCTAssertEqual(updated.createdAt, goal.createdAt)
        XCTAssertEqual(updated.revision, 2)
        XCTAssertEqual(updated.targetMinutes, 700)
        XCTAssertThrowsError(try StudyRules.goal(minutes: 0, at: now, timeZone: "Australia/Sydney")) { error in XCTAssertTrue(error is CentreError) }
        XCTAssertThrowsError(try StudyRules.goal(minutes: 10081, at: now, timeZone: "Australia/Sydney")) { error in XCTAssertTrue(error is CentreError) }
        XCTAssertThrowsError(try StudyRules.goal(minutes: 600, at: now.addingTimeInterval(604800), timeZone: "Australia/Sydney", existing: goal)) { error in XCTAssertTrue(error is CentreError) }
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(goal)) as? [String: Any])
        XCTAssertTrue(fields["deletedAt"] is NSNull)
    }
}
