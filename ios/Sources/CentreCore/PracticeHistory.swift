import Foundation

public struct PracticeQuestionMark: Equatable, Sendable {
    public let questionId: String
    public let score: Double?
    public let maxScore: Double?
    public let feedback: String?
    public let needsReview: Bool?

    public var normalizedScore: Double? {
        guard let score, let maxScore, score.isFinite, maxScore.isFinite,
              maxScore > 0, score >= 0, score <= maxScore else { return nil }
        return score / maxScore * 100
    }
}

public enum PracticeQuestionOutcome: String, Equatable, Sendable {
    case unanswered
    case incorrect
    case partial
    case correct
    case ungraded
}

public struct PracticeAttemptQuestion: Equatable, Identifiable, Sendable {
    public let id: String
    public let answer: String
    public let outcome: PracticeQuestionOutcome
    public let marking: PracticeQuestionMark?
}

public struct PracticeAttemptSummary: Equatable, Sendable {
    public let percent: Double?
    public let questions: Int
    public let answered: Int
    public let unanswered: Int
    public let correct: Int
    public let partial: Int
    public let incorrect: Int
    public let ungraded: Int
}

public struct PracticeAttemptSnapshot: Equatable, Identifiable, Sendable {
    /// A replica key, including kind, so legacy and v1 records with the same UUID stay distinct.
    public let id: String
    public let recordId: String
    public let kind: String
    public let resourceId: String
    public let createdAt: String
    public let answers: [String: String]
    public let score: Double?
    public let total: Double?
    public let feedback: [PracticeQuestionMark]

    public var normalizedScore: Double? {
        guard let score, let total, score.isFinite, total.isFinite,
              total > 0, score >= 0, score <= total else { return nil }
        return score / total * 100
    }

    /// Saved feedback order comes first; answer-only IDs are appended in stable order.
    public var questions: [PracticeAttemptQuestion] {
        var ids: [String] = []
        var seen = Set<String>()
        for item in feedback where seen.insert(item.questionId).inserted { ids.append(item.questionId) }
        ids.append(contentsOf: answers.keys.filter { seen.insert($0).inserted }.sorted())
        let groupedFeedback = Dictionary(grouping: feedback, by: \.questionId)
        return ids.map { questionId in
            let answer = answers[questionId] ?? ""
            let matches = groupedFeedback[questionId] ?? []
            let marking = matches.count == 1 ? matches[0] : nil
            let outcome: PracticeQuestionOutcome
            if answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                outcome = .unanswered
            } else if let percent = marking?.normalizedScore {
                if percent == 100 { outcome = .correct }
                else if percent == 0 { outcome = .incorrect }
                else { outcome = .partial }
            } else {
                outcome = .ungraded
            }
            return PracticeAttemptQuestion(id: questionId, answer: answer, outcome: outcome, marking: marking)
        }
    }

    public var summary: PracticeAttemptSummary {
        let questions = self.questions
        func count(_ outcome: PracticeQuestionOutcome) -> Int { questions.filter { $0.outcome == outcome }.count }
        return PracticeAttemptSummary(
            percent: normalizedScore,
            questions: questions.count,
            answered: questions.filter { !$0.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count,
            unanswered: count(.unanswered),
            correct: count(.correct),
            partial: count(.partial),
            incorrect: count(.incorrect),
            ungraded: count(.ungraded)
        )
    }

    public var questionIds: Set<String> { Set(questions.map(\.id)) }

    public init?(record: CloudRecord) {
        guard ["attempt", "practice.attempt"].contains(record.kind),
              record.schemaVersion == 1,
              let data = record.data,
              let resourceId = data["resourceId"].string,
              let createdAt = data["createdAt"].string,
              (data["schemaVersion"].int ?? 1) == 1 else { return nil }

        var answers: [String: String] = [:]
        if case .object(let savedAnswers) = data["answers"] {
            for (questionId, value) in savedAnswers {
                if let answer = value.string { answers[questionId] = answer }
            }
        }
        let result = data["result"]
        let feedback = result["feedback"].array.compactMap { item -> PracticeQuestionMark? in
            guard let questionId = item["questionId"].string else { return nil }
            return PracticeQuestionMark(
                questionId: questionId,
                score: item["score"].doubleValue,
                maxScore: item["maxScore"].doubleValue,
                feedback: item["feedback"].string,
                needsReview: item["needsReview"].boolValue
            )
        }

        id = record.key
        recordId = record.id
        kind = record.kind
        self.resourceId = resourceId
        self.createdAt = createdAt
        self.answers = answers
        score = result["score"].doubleValue
        total = result["total"].doubleValue
        self.feedback = feedback
    }

    public func answer(for questionId: String) -> String? { answers[questionId] }
}

public enum PracticeQuestionChange: String, Equatable, Sendable {
    case improved
    case lower
    case repeatedMistake = "repeated-mistake"
    case same
    case unanswered
    case answeredNow = "answered-now"
    case changedMarking = "changed-marking"
    case notShared = "not-shared"
    case ungraded
}

public struct PracticeQuestionComparison: Equatable, Sendable, Identifiable {
    public let id: String
    public let previous: PracticeAttemptQuestion?
    public let current: PracticeAttemptQuestion?
    public let change: PracticeQuestionChange
    /// This can be true at the same time as `change == .improved` for a partial answer.
    public let repeatedMistake: Bool
}

public struct PracticeAttemptComparison: Equatable, Sendable {
    public let earlier: PracticeAttemptSnapshot
    public let later: PracticeAttemptSnapshot
    public let sameQuestionSet: Bool
    public let sameMarking: Bool
    public let differentTotal: Bool
    public let percentagePointChange: Double?
    public let questions: [PracticeQuestionComparison]

    public var sharedQuestions: Int { questions.filter { $0.previous != nil && $0.current != nil }.count }

    /// An overall label is safe only when the saved question set and per-question maxima match.
    public var overallTrend: PracticeScoreTrend? {
        guard sameQuestionSet, sameMarking, !differentTotal, let change = percentagePointChange else { return nil }
        if change > 0 { return .improved }
        if change < 0 { return .declined }
        return .unchanged
    }

    public var trendCounts: [PracticeQuestionChange: Int] {
        questions.reduce(into: [:]) { counts, question in
            if question.change != .notShared && question.change != .ungraded {
                counts[question.change, default: 0] += 1
            }
        }
    }

    public var repeatedMistakeCount: Int { questions.filter(\.repeatedMistake).count }

    public init?(first: PracticeAttemptSnapshot, second: PracticeAttemptSnapshot) {
        guard first.id != second.id, first.resourceId == second.resourceId else { return nil }
        let ordered = PracticeAttemptChronology.chronological([first, second])
        guard ordered.count == 2 else { return nil }
        let earlier = ordered[0]
        let later = ordered[1]
        self.earlier = earlier
        self.later = later

        let before = earlier.questions
        let after = later.questions
        let beforeById = Dictionary(uniqueKeysWithValues: before.map { ($0.id, $0) })
        let afterById = Dictionary(uniqueKeysWithValues: after.map { ($0.id, $0) })
        sameQuestionSet = before.count == after.count && before.allSatisfy { afterById[$0.id] != nil }
        sameMarking = sameQuestionSet && before.allSatisfy { question in
            guard let earlierMarking = question.marking,
                  earlierMarking.normalizedScore != nil,
                  let later = afterById[question.id],
                  let laterMarking = later.marking,
                  laterMarking.maxScore == earlierMarking.maxScore,
                  later.outcome != .ungraded else { return false }
            return true
        }
        differentTotal = earlier.total != later.total
        if let previousPercent = earlier.normalizedScore, let currentPercent = later.normalizedScore {
            percentagePointChange = currentPercent - previousPercent
        } else {
            percentagePointChange = nil
        }

        var ids = before.map(\.id)
        let known = Set(ids)
        ids.append(contentsOf: after.map(\.id).filter { !known.contains($0) })
        questions = ids.map { questionId in
            let previous = beforeById[questionId]
            let current = afterById[questionId]
            let change: PracticeQuestionChange
            if previous == nil || current == nil {
                change = .notShared
            } else if current?.outcome == .unanswered {
                change = .unanswered
            } else if previous?.outcome == .unanswered {
                change = .answeredNow
            } else if previous?.marking == nil || current?.marking == nil
                        || previous?.outcome == .ungraded || current?.outcome == .ungraded {
                change = .ungraded
            } else if previous?.marking?.maxScore != current?.marking?.maxScore {
                change = .changedMarking
            } else if let oldScore = previous?.marking?.score, let newScore = current?.marking?.score, newScore > oldScore {
                change = .improved
            } else if let oldScore = previous?.marking?.score, let newScore = current?.marking?.score, newScore < oldScore {
                change = .lower
            } else if current?.outcome != .correct {
                change = .repeatedMistake
            } else {
                change = .same
            }
            let repeatedMistake = Self.isRepeatedMistake(previous, current)
            return PracticeQuestionComparison(id: questionId, previous: previous, current: current,
                                               change: change, repeatedMistake: repeatedMistake)
        }
    }

    private static func isRepeatedMistake(_ previous: PracticeAttemptQuestion?, _ current: PracticeAttemptQuestion?) -> Bool {
        guard let previous, let current,
              previous.outcome == .incorrect || previous.outcome == .partial,
              current.outcome == .incorrect || current.outcome == .partial,
              let oldMark = previous.marking, let newMark = current.marking,
              oldMark.maxScore == newMark.maxScore, oldMark.maxScore?.isFinite == true,
              oldMark.maxScore ?? 0 > 0 else { return false }
        return true
    }
}

public enum PracticeScoreTrend: String, Equatable, Sendable {
    case improved
    case declined
    case unchanged
}

public enum PracticeAttemptChronology {
    /// Orders saved attempts from oldest to newest, with a stable record ID tie-breaker.
    public static func chronological(_ attempts: [PracticeAttemptSnapshot]) -> [PracticeAttemptSnapshot] {
        attempts.sorted { lhs, rhs in
            let left = parse(lhs.createdAt)
            let right = parse(rhs.createdAt)
            if let left, let right {
                if left != right { return left < right }
                if lhs.recordId != rhs.recordId { return lhs.recordId < rhs.recordId }
                return lhs.id < rhs.id
            }
            if left != nil { return true }
            if right != nil { return false }
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            if lhs.recordId != rhs.recordId { return lhs.recordId < rhs.recordId }
            return lhs.id < rhs.id
        }
    }

    public static func newestFirst(_ attempts: [PracticeAttemptSnapshot]) -> [PracticeAttemptSnapshot] {
        Array(chronological(attempts).reversed())
    }

    private static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}

private extension JSONValue {
    var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}
