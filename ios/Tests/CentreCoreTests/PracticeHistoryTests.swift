import XCTest
@testable import CentreCore

final class PracticeHistoryTests: XCTestCase {
    func testAttemptsSortByTimeAndStableIdForTies() throws {
        let tied = "2026-10-22T01:00:00.000Z"
        let records = [
            try snapshot("later", createdAt: "2026-10-22T02:00:00.000Z"),
            try snapshot("tie-b", createdAt: tied),
            try snapshot("earlier", createdAt: "2026-10-22T00:00:00.000Z"),
            try snapshot("tie-a", createdAt: tied)
        ]

        XCTAssertEqual(PracticeAttemptChronology.chronological(records).map(\.recordId), [
            "earlier", "tie-a", "tie-b", "later"
        ])
        XCTAssertEqual(PracticeAttemptChronology.newestFirst(records).map(\.recordId), [
            "later", "tie-b", "tie-a", "earlier"
        ])
    }

    func testValidAttemptDatesSortBeforeLegacyDatesAndInvalidDatesSortLexically() throws {
        let records = [
            try snapshot("legacy-z", createdAt: "legacy-z"),
            try snapshot("legacy-a", createdAt: "legacy-a"),
            try snapshot("valid", createdAt: "2026-10-22T01:00:00.000Z")
        ]

        XCTAssertEqual(PracticeAttemptChronology.chronological(records).map(\.recordId), [
            "valid", "legacy-a", "legacy-z"
        ])
    }

    func testEqualInstantsUseAttemptIdThenReplicaKeyForTies() throws {
        let zulu = try snapshot("z-at-01", createdAt: "2026-10-22T01:00:00Z")
        let offset = try snapshot("a-at-12", createdAt: "2026-10-22T12:00:00+11:00")
        let legacy = try snapshot("duplicate", kind: "attempt", createdAt: "2026-10-22T01:00:00Z")
        let versioned = try snapshot("duplicate", kind: "practice.attempt", createdAt: "2026-10-22T01:00:00Z")

        XCTAssertEqual(PracticeAttemptChronology.chronological([zulu, offset]).map(\.recordId), ["a-at-12", "z-at-01"])
        XCTAssertEqual(PracticeAttemptChronology.chronological([versioned, legacy]).map(\.id), [
            "attempt/duplicate", "practice.attempt/duplicate"
        ])
    }

    func testAttemptSummaryUsesFeedbackThenAnswerOnlyIdsAndValidNormalizedMarks() throws {
        let attempt = try snapshot("saved", answers: [
            "correct": "Correct answer", "partial": "Partial answer", "incorrect": "Wrong answer",
            "unanswered": "  ", "invalid": "Answer with invalid marks", "answer-only": "Attempted"
        ], score: 2, total: 4, marks: [
            mark("correct", score: 2, max: 2),
            mark("partial", score: 1, max: 2),
            mark("incorrect", score: 0, max: 1),
            mark("unanswered", score: 0, max: 1),
            mark("invalid", score: 5, max: 2)
        ])

        XCTAssertEqual(attempt.questions.map(\.id), ["correct", "partial", "incorrect", "unanswered", "invalid", "answer-only"])
        XCTAssertEqual(attempt.normalizedScore, 50)
        XCTAssertEqual(attempt.summary.questions, 6)
        XCTAssertEqual(attempt.summary.answered, 5)
        XCTAssertEqual(attempt.summary.unanswered, 1)
        XCTAssertEqual(attempt.summary.correct, 1)
        XCTAssertEqual(attempt.summary.partial, 1)
        XCTAssertEqual(attempt.summary.incorrect, 1)
        XCTAssertEqual(attempt.summary.ungraded, 2)
    }

    func testComparisonSeparatesChangesFromRepeatedMistakeFlag() throws {
        let earlier = try snapshot("earlier", answers: [
            "partial": "first response", "mistake": "wrong", "blank": "   ", "answered-now": "",
            "lower": "strong response"
        ], score: 1, total: 6, marks: [
            mark("partial", score: 1, max: 2),
            mark("mistake", score: 0, max: 1),
            mark("blank", score: 0, max: 1),
            mark("answered-now", score: 0, max: 1),
            mark("lower", score: 1, max: 2),
            mark("old-only", score: 1, max: 1)
        ])
        let later = try snapshot("later", createdAt: "2026-10-23T00:00:00.000Z", answers: [
            "partial": "improved response", "mistake": "still wrong", "blank": "answered",
            "answered-now": "new response", "lower": "weaker response", "new-only": "answer"
        ], score: 2, total: 6, marks: [
            mark("partial", score: 1.5, max: 2),
            mark("mistake", score: 0, max: 1),
            mark("blank", score: 1, max: 1),
            mark("answered-now", score: 1, max: 1),
            mark("lower", score: 0, max: 2),
            mark("new-only", score: 1, max: 1)
        ])

        let comparison = try XCTUnwrap(PracticeAttemptComparison(first: earlier, second: later))
        XCTAssertFalse(comparison.sameQuestionSet)
        XCTAssertNil(comparison.overallTrend)
        XCTAssertEqual(comparison.sharedQuestions, 5)
        XCTAssertEqual(comparison.questions.first { $0.id == "partial" }?.change, .improved)
        XCTAssertEqual(comparison.questions.first { $0.id == "partial" }?.repeatedMistake, true,
                       "Repeated mistake is an independent flag and may coexist with partial improvement.")
        XCTAssertEqual(comparison.questions.first { $0.id == "mistake" }?.change, .repeatedMistake)
        XCTAssertEqual(comparison.questions.first { $0.id == "mistake" }?.repeatedMistake, true)
        XCTAssertEqual(comparison.questions.first { $0.id == "blank" }?.change, .answeredNow)
        XCTAssertEqual(comparison.questions.first { $0.id == "answered-now" }?.change, .answeredNow)
        XCTAssertEqual(comparison.questions.first { $0.id == "lower" }?.change, .lower)
        XCTAssertEqual(comparison.questions.first { $0.id == "old-only" }?.change, .notShared)
        XCTAssertEqual(comparison.questions.first { $0.id == "new-only" }?.change, .notShared)
        XCTAssertEqual(comparison.repeatedMistakeCount, 3)
    }

    func testUnansweredCurrentAttemptNeverCountsAsRepeatedMistake() throws {
        let earlier = try snapshot("earlier", answers: ["q": "wrong"], score: 0, total: 1,
                                   marks: [mark("q", score: 0, max: 1)])
        let later = try snapshot("later", createdAt: "2026-10-23T00:00:00.000Z", answers: ["q": "  "], score: 0, total: 1,
                                 marks: [mark("q", score: 0, max: 1)])

        let comparison = try XCTUnwrap(PracticeAttemptComparison(first: earlier, second: later))
        XCTAssertEqual(comparison.questions.first?.change, .unanswered)
        XCTAssertFalse(comparison.questions.first?.repeatedMistake ?? true)
        XCTAssertEqual(comparison.repeatedMistakeCount, 0)
    }

    func testChangedMaxMarksAndInvalidDenominatorsDoNotClaimImprovement() throws {
        let earlier = try snapshot("earlier", answers: ["changed": "answer", "invalid": "answer"], score: 1, total: 2,
                                   marks: [mark("changed", score: 1, max: 2), mark("invalid", score: 3, max: 2)])
        let later = try snapshot("later", createdAt: "2026-10-23T00:00:00.000Z", answers: ["changed": "answer", "invalid": "answer"], score: 2, total: 0,
                                 marks: [mark("changed", score: 2, max: 3), mark("invalid", score: 2, max: 2)])

        let comparison = try XCTUnwrap(PracticeAttemptComparison(first: earlier, second: later))
        XCTAssertNil(comparison.percentagePointChange)
        XCTAssertFalse(comparison.sameMarking)
        XCTAssertNil(comparison.overallTrend)
        XCTAssertEqual(comparison.questions.first { $0.id == "changed" }?.change, .changedMarking)
        XCTAssertEqual(comparison.questions.first { $0.id == "invalid" }?.change, .ungraded)
    }

    func testDuplicateOrMissingGradedFeedbackDoesNotCountAsSameMarking() throws {
        let earlier = try snapshot("earlier", answers: ["q": "answer"], score: 1, total: 1,
                                   marks: [mark("q", score: 1, max: 1)])
        let duplicateFeedback = try snapshot("later", createdAt: "2026-10-23T00:00:00.000Z",
                                             answers: ["q": "answer"], score: 1, total: 1,
                                             marks: [mark("q", score: 1, max: 1), mark("q", score: 1, max: 1)])

        let duplicateComparison = try XCTUnwrap(PracticeAttemptComparison(first: earlier, second: duplicateFeedback))
        XCTAssertFalse(duplicateComparison.sameMarking)
        XCTAssertEqual(duplicateComparison.questions.first?.change, .ungraded)

        let missingFeedback = try snapshot("missing", createdAt: "2026-10-24T00:00:00.000Z",
                                           answers: ["q": "answer"], score: 1, total: 1, marks: [])
        let missingComparison = try XCTUnwrap(PracticeAttemptComparison(first: earlier, second: missingFeedback))
        XCTAssertFalse(missingComparison.sameMarking)
        XCTAssertEqual(missingComparison.questions.first?.change, .ungraded)
    }

    func testComparisonRejectsDifferentResourcesAndKeepsDeletedResourceAttemptData() throws {
        let earlier = try snapshot("earlier", resourceId: "deleted-resource", answers: ["saved-question-id": "My answer"],
                                   marks: [mark("saved-question-id", score: 1, max: 1)])
        let later = try snapshot("later", resourceId: "other-resource", createdAt: "2026-10-23T00:00:00.000Z")

        XCTAssertNil(PracticeAttemptComparison(first: earlier, second: later))
        XCTAssertEqual(earlier.resourceId, "deleted-resource")
        XCTAssertEqual(earlier.questions.first?.id, "saved-question-id")
        XCTAssertEqual(earlier.questions.first?.answer, "My answer")
    }

    private func snapshot(_ id: String, kind: String = "practice.attempt", resourceId: String = "resource",
                          createdAt: String = "2026-10-22T00:00:00.000Z",
                          answers: [String: String] = [:], score: Double = 1, total: Double = 1,
                          marks: [JSONValue]? = nil) throws -> PracticeAttemptSnapshot {
        let answerValues = answers.mapValues(JSONValue.string)
        let data: JSONValue = .object([
            "schemaVersion": .number(1),
            "id": .string(id),
            "resourceId": .string(resourceId),
            "createdAt": .string(createdAt),
            "answers": .object(answerValues),
            "result": .object([
                "score": .number(score),
                "total": .number(total),
                "feedback": .array(marks ?? [mark("q", score: 1, max: 1)])
            ])
        ])
        let record = CloudRecord(kind: kind, id: id, data: data)
        return try XCTUnwrap(PracticeAttemptSnapshot(record: record))
    }

    private func mark(_ id: String, score: Double, max: Double, feedback: String = "Feedback") -> JSONValue {
        .object([
            "questionId": .string(id),
            "score": .number(score),
            "maxScore": .number(max),
            "feedback": .string(feedback),
            "needsReview": .bool(score < max)
        ])
    }
}
