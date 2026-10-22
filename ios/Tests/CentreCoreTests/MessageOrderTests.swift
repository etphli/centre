import XCTest
@testable import CentreCore

final class MessageOrderTests: XCTestCase {
    private let timestamp = "2026-10-22T01:00:00.000Z"
    private func message(_ id: String, created: String? = nil, sequence: String? = nil, cursor: String = "0") throws -> CloudRecord {
        let record = CloudRecord(kind: "message", id: id, version: 1, cursor: cursor,
                                 data: .object(["createdAt": .string(created ?? timestamp), "content": .string(id)]))
        var fields = try JSONValue.encode(record)
        if let sequence { fields["createdCursor"] = .string(sequence) }
        return try fields.decode(CloudRecord.self)
    }

    func testCreatedAtTakesPriorityOverCreationSequence() throws {
        let late = try message("late", created: "2026-10-22T02:00:00.000Z", sequence: "1")
        let early = try message("early", created: "2026-10-22T00:00:00.000Z", sequence: "999")
        XCTAssertEqual(CloudMessageOrder.sorted([late, early]).map(\.id), ["early", "late"])
    }

    func testTiedTimestampsUseCreationSequenceAndIgnoreUpdatedCursor() throws {
        let third = try message("third", sequence: "30", cursor: "1")
        let first = try message("first", sequence: "10", cursor: "999999")
        let second = try message("second", sequence: "20", cursor: "100")
        XCTAssertEqual(CloudMessageOrder.sorted([third, first, second]).map(\.id), ["first", "second", "third"])
    }

    func testArbitraryPrecisionDecimalAndLeadingZeros() throws {
        let records = try [
            message("largest", sequence: "100000000000000000000000000000000000000000000000000"),
            message("over-uint64", sequence: "18446744073709551616"),
            message("small", sequence: "0000002"),
            message("next", sequence: "18446744073709551617"),
            message("zero", sequence: "0000")
        ]
        XCTAssertEqual(CloudMessageOrder.sorted(records).map(\.id), ["zero", "small", "over-uint64", "next", "largest"])
    }

    func testLegacyAndMalformedSequencesKeepOriginalSlotsWithinTimestampGroup() throws {
        let records = try [
            message("third", sequence: "3"), message("legacy"), message("second", sequence: "2"),
            message("malformed", sequence: "-1"), message("first", sequence: "1"),
            message("unicode", sequence: "１２"), message("empty", sequence: "")
        ]
        let ordered = CloudMessageOrder.sorted(records)
        XCTAssertEqual(ordered.map(\.id), ["first", "legacy", "second", "malformed", "third", "unicode", "empty"])
        XCTAssertEqual(CloudMessageOrder.sorted(ordered), ordered)
    }

    func testEqualNumericSequencesAndAllLegacyRecordsKeepInputOrder() throws {
        let tied = try [message("a", sequence: "0007"), message("b", sequence: "7"), message("c")]
        XCTAssertEqual(CloudMessageOrder.sorted(tied), tied)
        let legacy = try [message("z"), message("a"), message("m")]
        XCTAssertEqual(CloudMessageOrder.sorted(legacy), legacy)
        XCTAssertTrue(CloudMessageOrder.sorted([]).isEmpty)
    }
}
