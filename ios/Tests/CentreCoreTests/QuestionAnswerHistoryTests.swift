import XCTest
@testable import CentreCore

final class QuestionAnswerHistoryTests: XCTestCase {
    private func message(
        _ id: String,
        role: String = "user",
        content: String,
        page: String? = "question-answer",
        kind: String = "message"
    ) -> CloudRecord {
        let context: JSONValue = page.map { .object([
            "page": .string($0),
            "subjectId": .string("biology"),
            "topicId": .string("cell-structure"),
            "resourceId": .string("study-plan")
        ]) } ?? .null
        return CloudRecord(kind: kind, id: id, version: 1, data: .object([
            "id": .string(id),
            "role": .string(role),
            "content": .string(content),
            "requestContext": context
        ]))
    }

    func testTaggedAnswersMoveBeforeTheFollowingAssistantInTheirOriginalOrder() throws {
        let prompt = message("prompt", role: "user", content: "Make a study plan.", page: "chat")
        let first = message("answer-1", content: "When should I study?\nAfter school.")
        let second = message("answer-2", content: "How long?\nThirty minutes.")
        let reply = message("reply", role: "assistant", content: "Here is your plan.", page: nil)

        let items = QuestionAnswerHistory.project([prompt, first, second, reply])

        XCTAssertEqual(items.map(\.id), ["message-prompt", "clarification-before-reply", "message-reply"])
        guard case .clarification(let details) = items[1] else {
            return XCTFail("Question and answer records should appear as reasoning details.")
        }
        XCTAssertFalse(details.isPending)
        XCTAssertEqual(details.batches, [
            ClarificationBatch(id: "answer-1", content: "When should I study?\nAfter school."),
            ClarificationBatch(id: "answer-2", content: "How long?\nThirty minutes.")
        ])
        XCTAssertEqual(first.data?["requestContext"]["page"], .string("question-answer"))
        XCTAssertEqual(first.data?["requestContext"]["subjectId"], .string("biology"))
        XCTAssertEqual(first.data?["requestContext"]["topicId"], .string("cell-structure"))
        XCTAssertEqual(first.data?["requestContext"]["resourceId"], .string("study-plan"))
    }

    func testTrailingAnswersStayAvailableAsPendingAndReclassifyAfterSync() throws {
        let prompt = message("prompt", role: "user", content: "Make a study plan.", page: "chat")
        let answer = message("answer", content: "What time?\nAfter school.")
        let pending = QuestionAnswerHistory.project([prompt, answer])

        XCTAssertEqual(pending.count, 2)
        guard case .clarification(let pendingDetails) = pending.last else {
            return XCTFail("Trailing clarification answers should remain visible as pending details.")
        }
        XCTAssertTrue(pendingDetails.isPending)
        XCTAssertEqual(pendingDetails.batches.first?.content, "What time?\nAfter school.")

        let reply = message("reply", role: "assistant", content: "Here is your plan.", page: nil)
        let completed = QuestionAnswerHistory.project([prompt, answer, reply])
        guard case .clarification(let completedDetails) = completed[1] else {
            return XCTFail("A synced assistant response should receive the preceding answer details.")
        }
        XCTAssertFalse(completedDetails.isPending)
        XCTAssertEqual(completedDetails.batches, pendingDetails.batches)
    }

    func testOnlyExactTaggedUserMessagesAreProjectedAndOrdinaryHistoryIsUnchanged() throws {
        let prompt = message("prompt", role: "user", content: "A line\nthat looks like a question-answer pair.", page: "chat")
        let wrongPage = message("wrong-page", content: "Keep\nthis as typed.", page: "resource")
        let assistantWithTag = message("assistant", role: "assistant", content: "Keep assistant text.", page: "question-answer")
        let wrongRecordKind = message("wrong-kind", content: "Keep this record.", kind: "other")
        let tagged = message("tagged", content: "Choose a topic?\nCells.")

        XCTAssertFalse(QuestionAnswerHistory.isClarificationRecord(prompt))
        XCTAssertFalse(QuestionAnswerHistory.isClarificationRecord(wrongPage))
        XCTAssertFalse(QuestionAnswerHistory.isClarificationRecord(assistantWithTag))
        XCTAssertFalse(QuestionAnswerHistory.isClarificationRecord(wrongRecordKind))
        XCTAssertTrue(QuestionAnswerHistory.isClarificationRecord(tagged))

        let items = QuestionAnswerHistory.project([prompt, wrongPage, assistantWithTag, wrongRecordKind, tagged])
        let visible = items.compactMap { item -> CloudRecord? in
            guard case .message(let record) = item else { return nil }
            return record
        }
        XCTAssertEqual(visible, [prompt, wrongPage, assistantWithTag, wrongRecordKind])
        guard case .clarification(let details) = items.last else {
            return XCTFail("The exact tagged answer should be projected after ordinary history.")
        }
        XCTAssertTrue(details.isPending)
        XCTAssertEqual(details.batches.first?.content, "Choose a topic?\nCells.")
    }

    func testFullBatchContentIsPreservedWithoutParsingQuestionBoundaries() throws {
        let first = message("first", content: "When should I study?\nAfter school.\n\nHow long?\nThirty minutes.")
        let second = message("second", content: "What subject?\nBiology.")
        let items = QuestionAnswerHistory.project([first, second])

        guard case .clarification(let details) = items.first else {
            return XCTFail("Tagged messages should remain grouped as full clarification batches.")
        }
        XCTAssertEqual(details.batches, [
            ClarificationBatch(id: "first", content: "When should I study?\nAfter school.\n\nHow long?\nThirty minutes."),
            ClarificationBatch(id: "second", content: "What subject?\nBiology.")
        ])
    }
}
