import Foundation

public struct ClarificationBatch: Equatable, Identifiable, Sendable {
    public let id: String
    public let content: String

    public init(id: String, content: String) {
        self.id = id
        self.content = content
    }
}

public struct ClarificationDetails: Equatable, Identifiable, Sendable {
    public let id: String
    public let batches: [ClarificationBatch]
    public let isPending: Bool

    public init(id: String, batches: [ClarificationBatch], isPending: Bool) {
        self.id = id
        self.batches = batches
        self.isPending = isPending
    }
}

public enum ChatHistoryItem: Equatable, Identifiable, Sendable {
    case message(CloudRecord)
    case clarification(ClarificationDetails)

    public var id: String {
        switch self {
        case .message(let record): "message-\(record.id)"
        case .clarification(let details): "clarification-\(details.id)"
        }
    }
}

/// Projects tagged clarification answer records into reasoning details without changing synced data.
public enum QuestionAnswerHistory {
    public static func isClarificationRecord(_ record: CloudRecord) -> Bool {
        guard record.kind == "message", let data = record.data else { return false }
        return data["role"].string == "user"
            && data["requestContext"]["page"].string == "question-answer"
    }

    /// The input must already be in conversation order, as returned by `CloudMessageOrder.sorted`.
    public static func project(_ records: [CloudRecord]) -> [ChatHistoryItem] {
        var result: [ChatHistoryItem] = []
        var pendingBatches: [ClarificationBatch] = []

        for record in records {
            if isClarificationRecord(record) {
                pendingBatches.append(batch(for: record))
                continue
            }

            if !pendingBatches.isEmpty {
                let isFollowingAssistant = record.data?["role"].string == "assistant"
                let id = isFollowingAssistant
                    ? "before-\(record.id)"
                    : "pending-\(pendingBatches[pendingBatches.count - 1].id)"
                result.append(.clarification(ClarificationDetails(
                    id: id,
                    batches: pendingBatches,
                    isPending: !isFollowingAssistant
                )))
                pendingBatches.removeAll(keepingCapacity: true)
            }

            result.append(.message(record))
        }

        if !pendingBatches.isEmpty {
            result.append(.clarification(ClarificationDetails(
                id: "pending-\(pendingBatches[pendingBatches.count - 1].id)",
                batches: pendingBatches,
                isPending: true
            )))
        }

        return result
    }

    private static func batch(for record: CloudRecord) -> ClarificationBatch {
        ClarificationBatch(id: record.id, content: record.data?["content"].string ?? "")
    }
}
