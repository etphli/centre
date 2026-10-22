import Foundation
import XCTest
@testable import CentreCore

final class StudyFixtureTests: XCTestCase {
    // Copied unchanged from study-log commit 54d417c69ef6c147ea5fd01764187c3ef9458e35.
    private func fixture() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/study-log-v1.json")
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    func testCanonicalCrossLanguageRecordsAndExpectedDurations() throws {
        let fixture = try fixture()
        XCTAssertEqual(fixture["schemaVersion"].int, 1)
        XCTAssertEqual(fixture["log"]["schemaVersion"].int, 1)
        let now = try Clock.date(XCTUnwrap(fixture["now"].string))
        let sessionJSON = fixture["log"]["sessions"].array
        let sessions = try sessionJSON.map { try $0.decode(StudySession.self) }
        XCTAssertEqual(try sessions.map { try JSONValue.encode($0) }, sessionJSON)
        let goalJSON = fixture["log"]["goals"].array
        let goals = try goalJSON.map { try $0.decode(WeeklyStudyGoal.self) }
        XCTAssertEqual(try goals.map { try JSONValue.encode($0) }, goalJSON)
        let goal = try XCTUnwrap(goals.first)
        XCTAssertEqual(try StudyRules.weekStart(at: now, timeZone: goal.timeZone), goal.weekStart)

        let recovered = try sessions.map { try StudyRules.recover($0, now: now, restart: true) }
        for session in recovered { try StudyRules.validate(session, now: now) }
        let importedIndex = try XCTUnwrap(sessions.firstIndex { $0.state.kind == "running" })
        let imported = recovered[importedIndex]
        XCTAssertEqual(imported.state, .paused(reason: "recovery"))
        XCTAssertEqual(imported.revision, fixture["expected"]["recoveredTimerRevision"].int)
        XCTAssertEqual(try StudyRules.weeklyDuration([imported], at: now, timeZone: goal.timeZone) * 1000,
                       Double(try XCTUnwrap(fixture["expected"]["recoveredTimerDurationMs"].int)))
        XCTAssertEqual(try StudyRules.weeklyDuration(recovered, at: now, timeZone: goal.timeZone) * 1000,
                       Double(try XCTUnwrap(fixture["expected"]["currentWeekDurationMs"].int)))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: goal.timeZone))
        let previousWeek = try XCTUnwrap(calendar.date(byAdding: .day, value: -7, to: now))
        XCTAssertEqual(try StudyRules.weeklyDuration(recovered, at: previousWeek, timeZone: goal.timeZone) * 1000,
                       Double(try XCTUnwrap(fixture["expected"]["previousWeekDurationMs"].int)))
    }

    func testCanonicalDSTDayLengthExpectations() throws {
        let fixture = try fixture()
        let now = try Clock.date(XCTUnwrap(fixture["now"].string))
        let days = fixture["days"].array
        XCTAssertEqual(days.count, 2)
        for day in days {
            let zone = try XCTUnwrap(day["timeZone"].string)
            let start = try CalendarPlan.localStart(date: XCTUnwrap(day["date"].string), time: "00:00", timeZone: zone)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: zone))
            let end = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: start))
            let expectedMs = Double(try XCTUnwrap(day["durationMs"].int))
            XCTAssertEqual(end.timeIntervalSince(start) * 1000, expectedMs)
            let session = try StudyRules.manual(title: "Canonical DST day", subjectId: nil, timeZone: zone, start: start, end: end, now: now)
            XCTAssertEqual(try StudyRules.weeklyDuration([session], at: start, timeZone: zone) * 1000, expectedMs)
        }
    }
}
