import Foundation
import XCTest
@testable import CentreCore

final class CalendarPlanTests: XCTestCase {
    private func date(_ value: String) throws -> Date { try Clock.date(value) }

    func testCanonicalSessionDTOAndLocalStartMatch() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        let start = try date("2026-10-22T13:20:34.123Z")
        let plan = try CalendarPlan.create(title: "  Algebra revision \n", start: start, timeZone: "Australia/Sydney", durationMinutes: 75, subjectId: "math", now: now)
        guard case let .object(fields) = plan else { return XCTFail("Expected canonical planned session object.") }
        XCTAssertEqual(Set(fields.keys), Set(["schemaVersion", "id", "revision", "createdAt", "updatedAt", "deletedAt", "origin", "kind", "title", "date", "time", "timeZone", "startAt", "plannedDurationMinutes", "subjectId", "notes", "completedAt", "organatoId", "organatoVersion"]))
        XCTAssertNotNil(plan["id"].string.flatMap(UUID.init(uuidString:)))
        XCTAssertEqual(plan["origin"], .string("centre"))
        XCTAssertEqual(plan["kind"], .string("session"))
        XCTAssertEqual(plan["schemaVersion"].int, 1)
        XCTAssertEqual(plan["revision"].int, 1)
        XCTAssertEqual(plan["createdAt"], .string("2026-10-22T00:00:00.000Z"))
        XCTAssertEqual(plan["updatedAt"], plan["createdAt"])
        XCTAssertEqual(plan["title"], .string("Algebra revision"))
        XCTAssertEqual(plan["date"], .string("2026-10-23"))
        XCTAssertEqual(plan["time"], .string("00:20:34.123"))
        XCTAssertEqual(plan["timeZone"], .string("Australia/Sydney"))
        XCTAssertEqual(plan["startAt"], .string("2026-10-22T13:20:34.123Z"))
        XCTAssertEqual(plan["plannedDurationMinutes"].int, 75)
        XCTAssertEqual(plan["subjectId"], .string("math"))
        XCTAssertEqual(plan["notes"], .string(""))
        for key in ["deletedAt", "completedAt", "organatoId", "organatoVersion"] { XCTAssertEqual(plan[key], .null) }
        XCTAssertEqual(try CalendarPlan.localStart(date: "2026-10-23", time: "00:20:34.123", timeZone: "Australia/Sydney").timeIntervalSince1970, start.timeIntervalSince1970, accuracy: 0.000001)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan)) as? [String: Any]
        XCTAssertTrue(json?["organatoVersion"] is NSNull)
    }

    func testDSTGapRejectedAndSpringBoundaryHasCorrectWallTimes() throws {
        XCTAssertThrowsError(try CalendarPlan.localStart(date: "2026-10-04", time: "02:30", timeZone: "Australia/Sydney"))
        let before = try CalendarPlan.create(title: "Before change", start: date("2026-10-03T15:59:59.000Z"), timeZone: "Australia/Sydney")
        let after = try CalendarPlan.create(title: "After change", start: date("2026-10-03T16:00:00.000Z"), timeZone: "Australia/Sydney")
        XCTAssertEqual(before["time"], .string("01:59:59"))
        XCTAssertEqual(after["time"], .string("03:00:00"))
        XCTAssertEqual(before["date"], after["date"])
    }

    func testBothRepeatedHourInstantsRejectedForNewPlans() throws {
        XCTAssertThrowsError(try CalendarPlan.localStart(date: "2026-04-05", time: "02:30:12.123", timeZone: "Australia/Sydney"))
        for instant in ["2026-04-04T15:30:12.123Z", "2026-04-04T16:30:12.123Z"] {
            XCTAssertThrowsError(try CalendarPlan.create(title: "Repeated hour", start: date(instant), timeZone: "Australia/Sydney"))
        }
        XCTAssertNoThrow(try CalendarPlan.create(title: "After change", start: date("2026-04-04T17:00:00.000Z"), timeZone: "Australia/Sydney"))
    }

    func testValidationAndDurationBounds() throws {
        let now = try date("2026-10-22T00:00:00.000Z")
        for title in ["  \n", String(repeating: "a", count: 201)] {
            XCTAssertThrowsError(try CalendarPlan.create(title: title, start: now, timeZone: "UTC"))
        }
        for duration in [4, 721] {
            XCTAssertThrowsError(try CalendarPlan.create(title: "Revision", start: now, timeZone: "UTC", durationMinutes: duration))
        }
        for duration in [5, 720] {
            XCTAssertEqual(try CalendarPlan.create(title: "Revision", start: now, timeZone: "UTC", durationMinutes: duration)["plannedDurationMinutes"].int, duration)
        }
        let defaultPlan = try CalendarPlan.create(title: "Revision", start: now, timeZone: "UTC")
        XCTAssertEqual(defaultPlan["plannedDurationMinutes"].int, 60)
        XCTAssertEqual(defaultPlan["subjectId"], .null)
        XCTAssertEqual(defaultPlan["time"], .string("00:00:00"))
        for zone in ["Not/AZone", "PST", "GMT+1100"] { XCTAssertThrowsError(try CalendarPlan.create(title: "Revision", start: now, timeZone: zone)) }
        for localDate in ["2026-02-30", "2026-13-01", "2026-1-01"] { XCTAssertThrowsError(try CalendarPlan.localStart(date: localDate, time: "12:00", timeZone: "UTC")) }
        XCTAssertThrowsError(try CalendarPlan.localStart(date: "2026-10-22", time: "24:00", timeZone: "UTC"))
    }
}
