import XCTest
@testable import CentreCore

final class NotificationResourcesTests: XCTestCase {
    func testFiltersNotificationResourcesAndMatchesAssignment() {
        let notification = resource("notification", itemId: "assignment-1")
        let unrelated = resource("other", itemId: "assignment-2")
        let ordinary = CloudRecord(kind: "resource", id: "ordinary", data: .object([
            "kind": .string("notes"), "deletedAt": .null
        ]))
        let deleted = resource("deleted", itemId: "assignment-1", deletedAt: "2026-10-30T00:00:00Z")

        XCTAssertTrue(NotificationResources.isNotification(notification))
        XCTAssertFalse(NotificationResources.isNotification(ordinary))
        XCTAssertFalse(NotificationResources.isNotification(deleted))
        XCTAssertEqual(NotificationResources.linked(toAssignment: "assignment-1", in: [ordinary, unrelated, deleted, notification]).map(\.id), ["notification"])
        XCTAssertTrue(NotificationResources.linked(toAssignment: "", in: [notification]).isEmpty)
    }

    func testAssignmentContextRetainsSourceTextSeparatelyFromStudentMessage() {
        let note = CloudRecord(kind: "resource", id: "brief", data: .object([
            "title": .string("Homework brief"), "kind": .string("notes"),
            "content": .string(String(repeating: "x", count: 20_000)),
            "notification": .object(["itemId": .string("assignment-1"), "fileName": .string("brief.pdf")])
        ]))
        let assignments: [JSONValue] = [.object(["id": .string("assignment-1"), "title": .string("Algebra worksheet"), "subjectId": .string("math")])]
        let context = NotificationResources.assignmentContext(text: "Help with Algebra worksheet", assignments: assignments, resources: [note])
        XCTAssertEqual(context?.resourceId, "brief")
        XCTAssertTrue(context?.untrustedContent.hasPrefix("xx") == true)
        XCTAssertEqual(context?.untrustedContent.count, 20_000)
        let subjectContext = NotificationResources.assignmentContext(text:"Help with maths", assignments:assignments, resources:[note], subjects:[.object(["id":.string("math"),"name":.string("Mathematics"),"shortName":.string("Maths")])])
        XCTAssertEqual(subjectContext?.resourceId,"brief")
    }

    private func resource(_ id: String, itemId: String, deletedAt: String? = nil) -> CloudRecord {
        CloudRecord(kind: "resource", id: id, data: .object([
            "kind": .string("notes"), "deletedAt": deletedAt.map(JSONValue.string) ?? .null,
            "updatedAt": .string("2026-10-31T00:00:00Z"),
            "notification": .object(["itemId": .string(itemId)])
        ]))
    }
}
