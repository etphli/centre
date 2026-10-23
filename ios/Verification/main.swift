import Foundation
import CentreCore

private struct VerificationFailure: Error, CustomStringConvertible {
    let description: String
}
private func check(_ condition: @autoclosure () throws -> Bool, _ outcome: String) throws {
    guard try condition() else { throw VerificationFailure(description: outcome) }
}
private func practiceMark(_ questionId: String, score: Double, maxScore: Double) -> JSONValue {
    .object(["questionId":.string(questionId),"score":.number(score),"maxScore":.number(maxScore),
             "feedback":.string("Saved feedback"),"needsReview":.bool(false)])
}
private func practiceRecord(_ id: String, kind: String = "practice.attempt", resourceId: String = "r1",
                            createdAt: String, answers: [String: String] = [:], score: Double = 0,
                            total: Double = 1, feedback: [JSONValue] = []) -> CloudRecord {
    CloudRecord(kind: kind, id: id, data: .object([
        "schemaVersion":.number(1),"id":.string(id),"resourceId":.string(resourceId),
        "createdAt":.string(createdAt),
        "answers":.object(answers.mapValues(JSONValue.string)),
        "result":.object(["score":.number(score),"total":.number(total),"feedback":.array(feedback)])
    ]))
}
private func practiceSnapshot(_ record: CloudRecord) throws -> PracticeAttemptSnapshot {
    guard let attempt = PracticeAttemptSnapshot(record: record) else {
        throw VerificationFailure(description: "Could not decode practice attempt \(record.key)")
    }
    return attempt
}

// Network outcomes are simulated. Persistence and timer rules execute against the real core.
private actor SimulatedTransport: CloudTransport {
    private var calls: [CloudMutation] = []
    private var receipts: [String: CloudRecord] = [:]
    private var loseAcknowledgement = true
    private var conflict: CloudRecord?
    init(conflict: CloudRecord? = nil) { self.conflict = conflict }
    func sent() -> [CloudMutation] { calls }
    func put(_ mutation: CloudMutation) async throws -> MutationResponse {
        calls.append(mutation)
        if let conflict { return .conflict(conflict) }
        let record = receipts[mutation.mutationId] ?? CloudRecord(kind: mutation.kind, id: mutation.id, version: mutation.expectedVersion + 1, cursor: "1", deleted: mutation.deleted, data: mutation.data)
        receipts[mutation.mutationId] = record
        if loseAcknowledgement { loseAcknowledgement = false; throw URLError(.timedOut) }
        return .accepted(record)
    }
    func changes(cursor: String) async throws -> ChangesPage {
        ChangesPage(records: [], cursor: cursor, hasMore: false)
    }
    func run(_ request: AIRequest) async throws -> AIRun { AIRun(id: request.id, status: "completed") }
    func grade(_ request: GradeRequest) async throws -> AIRun { AIRun(id: request.id, status: "completed") }
}

@main
struct CentreCoreVerification {
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("centre-core-verification-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspace = try WorkspaceKey(baseURL: URL(string: "https://verification.invalid")!, workspaceId: "account-workspace")
        func reopen() throws -> Replica { try Replica(directory: directory, workspace: workspace) }
        func edit(_ title: String) -> LocalChange {
            LocalChange(kind: "resource", id: "r1", data: .object(["title": .string(title), "future": .array([.bool(true), .null])]))
        }
        let original = try reopen()
        try await original.stage([edit("Offline")])
        let staged = await original.snapshot()
        let reopened = try reopen()
        let disk = await reopened.snapshot()
        try check(disk.outbox == staged.outbox && disk.records == staged.records, "Reopened outbox and projection differ")
        try check(UUID(uuidString: disk.outbox[0].mutation.mutationId) != nil, "Mutation identity is not a UUID")
        print("PASS real filesystem outbox/projection reopen with stable mutation UUID")

        let network = SimulatedTransport()
        do {
            try await reopened.synchronize(using: network)
            throw VerificationFailure(description: "Simulated lost ACK did not fail")
        } catch let error as URLError { try check(error.code == .timedOut, "Unexpected simulated network failure") }
        let retry = try reopen()
        let timedOut = await retry.snapshot()
        try check(timedOut.outbox[0].sent, "Sent marker did not survive timeout and reopen")
        try await retry.stage([edit("After timeout")])
        try await retry.synchronize(using: network)
        let calls = await network.sent()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try check(calls.count == 3, "Lost ACK plus successor should issue three calls")
        try check(encoder.encode(calls[0]) == encoder.encode(calls[1]), "Retry changed sent body or UUID")
        try check(calls[2].expectedVersion == 1, "Successor did not receive acknowledged version")
        let synchronized = await (try reopen()).snapshot()
        try check(synchronized.outbox.isEmpty && synchronized.records[0].data?["title"] == .string("After timeout"), "Successor edit was lost")
        try check(synchronized.records[0].data?["future"] == .array([.bool(true), .null]), "Unknown JSON was lost")
        print("PASS simulated lost ACK replays exact body; real persisted successor survives")

        try await retry.stage([edit("Keep local")])
        let beforeConflict = await retry.snapshot()
        let remote = CloudRecord(kind: "resource", id: "r1", version: 9, cursor: "9", data: .object(["title": .string("Keep remote")]))
        try await retry.synchronize(using: SimulatedTransport(conflict: remote))
        let conflicted = await (try reopen()).snapshot()
        guard let conflict = conflicted.conflicts.first else { throw VerificationFailure(description: "CAS conflict was not persisted") }
        try check(conflict.local.data?["title"] == .string("Keep local") && conflict.remote == remote, "Conflict lost one side")
        try await retry.resolve(conflict, useLocal: true)
        let resolved = await (try reopen()).snapshot()
        try check(resolved.conflicts.isEmpty && resolved.outbox.count == 1, "Explicit resolution did not replace conflict")
        try check(resolved.outbox[0].mutation.expectedVersion == 9, "Resolution ignored observed remote version")
        try check(resolved.outbox[0].mutation.mutationId != beforeConflict.outbox[0].mutation.mutationId, "Resolution reused a sent mutation UUID")
        let otherKey = try WorkspaceKey(baseURL: workspace.baseURL, workspaceId: "other-account-workspace")
        let other = try Replica(directory: directory, workspace: otherKey)
        let isolated = await other.snapshot()
        try check(isolated.records.isEmpty && isolated.outbox.isEmpty, "Workspace cache leaked")
        print("PASS persisted explicit CAS conflict and fresh use-local UUID; workspace isolation")

        let now = try Clock.date("2026-10-22T01:00:00.000Z")
        let started = try StudyRules.start(title: "Imported timer", subjectId: nil, timeZone: "Australia/Sydney", now: Clock.date("2026-10-22T00:00:00.000Z"))
        let checkpoint = try StudyRules.heartbeat(started, now: Clock.date("2026-10-22T00:00:15.000Z"), activity: true)
        let timerFile = directory.appendingPathComponent("imported-timer.json")
        try JSONEncoder().encode(checkpoint).write(to: timerFile, options: .atomic)
        let imported = try JSONDecoder().decode(StudySession.self, from: Data(contentsOf: timerFile))
        try check(imported.targetMinutes == nil, "Legacy timer import gained a countdown target")
        let legacyFields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(started)) as? [String: Any]
        try check(legacyFields?["targetMinutes"] == nil, "Legacy timer encoding added a countdown target")
        let recovered = try StudyRules.recover(imported, now: now, restart: true)
        try check(recovered.state == .paused(reason: "recovery"), "Imported timer kept running")
        try check(recovered.segments.last?.end == "2026-10-22T00:00:15.000Z", "Recovery credited time after checkpoint")
        try check(StudyRules.weeklyDuration([recovered], at: now, timeZone: "Australia/Sydney") == 15, "Recovered duration exceeded checkpoint")
        try check(StudyRules.recover(recovered, now: now, restart: true) == recovered, "Recovery was not idempotent")
        print("PASS real timer JSON import pauses at persisted checkpoint without closed-app credit")

        let countdownStart = try Clock.date("2026-10-22T02:00:00.000Z")
        let metadataFree = try StudyRules.start(timeZone: "Australia/Sydney", now: countdownStart)
        try check(metadataFree.title == "Study session" && metadataFree.subjectId == nil, "Omitted timer metadata did not use the default title")
        var countdown = try StudyRules.start(title: "", subjectId: nil, targetMinutes: 5, timeZone: "Australia/Sydney", now: countdownStart)
        try check(countdown.title == "Study session" && countdown.targetMinutes == 5, "Optional timer metadata or selected duration was not saved")
        for minutes in [0, 4, 6, 1441, 1445] {
            var invalid = countdown
            invalid.targetMinutes = minutes
            try check((try? StudyRules.validate(invalid, now: countdownStart)) == nil, "Invalid countdown target \(minutes) was accepted")
        }
        for second in stride(from: 15, through: 285, by: 15) {
            countdown = try StudyRules.heartbeat(countdown, now: countdownStart.addingTimeInterval(Double(second)), activity: true)
        }
        countdown = try StudyRules.heartbeat(countdown, now: countdownStart.addingTimeInterval(305), activity: true)
        try check(countdown.state == .completed, "Countdown did not complete when its deadline passed")
        try check(countdown.segments.last?.end == Clock.iso(countdownStart.addingTimeInterval(300)), "Countdown credited time after its exact deadline")
        try check(try StudyRules.elapsedSeconds(countdown, now: countdownStart.addingTimeInterval(305)) == 300, "Countdown duration was not capped at five minutes")
        let cloudCountdown = CloudRecord(kind: "studySession", id: countdown.id, version: 1, cursor: "1", data: try JSONValue.encode(countdown))
        try check(try cloudCountdown.data?.decode(StudySession.self) == countdown, "Cloud record round-trip lost the countdown target or completion")
        print("PASS optional 5-minute countdown completes at the exact deadline")

        var pausedCountdown = try StudyRules.start(title: "Break-aware timer", subjectId: nil, targetMinutes: 30, timeZone: "Australia/Sydney", now: countdownStart)
        for second in stride(from: 15, through: 285, by: 15) {
            pausedCountdown = try StudyRules.heartbeat(pausedCountdown, now: countdownStart.addingTimeInterval(Double(second)), activity: true)
        }
        pausedCountdown = try StudyRules.pause(pausedCountdown, now: countdownStart.addingTimeInterval(300))
        try check(try StudyRules.remainingSeconds(pausedCountdown, now: countdownStart.addingTimeInterval(3600)) == 1500, "Paused time reduced the countdown")
        let resumedCountdown = try StudyRules.resume(pausedCountdown, now: countdownStart.addingTimeInterval(3600))
        let checkpointCountdown = try StudyRules.heartbeat(resumedCountdown, now: countdownStart.addingTimeInterval(3615), activity: true)
        let cloudRunningCountdown = CloudRecord(kind: "studySession", id: checkpointCountdown.id, version: 2, cursor: "2", data: try JSONValue.encode(checkpointCountdown))
        guard let synchronizedCountdown = try cloudRunningCountdown.data?.decode(StudySession.self) else {
            throw VerificationFailure(description: "Cloud import lost the running countdown data")
        }
        let importedCountdown = try StudyRules.recover(synchronizedCountdown, now: countdownStart.addingTimeInterval(4000), restart: true)
        try check(importedCountdown.targetMinutes == 30 && importedCountdown.state == .paused(reason: "recovery"), "Imported countdown lost its target or resumed running")
        try check(importedCountdown.segments.last?.end == Clock.iso(countdownStart.addingTimeInterval(3615)), "Imported countdown did not recover at its checkpoint")
        try check(try StudyRules.remainingSeconds(importedCountdown, now: countdownStart.addingTimeInterval(4000)) == 1485, "Recovery lost the selected duration or closed interval")
        print("PASS paused countdown excludes breaks and imports paused at its saved checkpoint")

        var idleCountdown = try StudyRules.start(title: "Idle boundary", subjectId: nil, targetMinutes: 30, timeZone: "Australia/Sydney", now: countdownStart)
        for second in stride(from: 15, through: 600, by: 15) {
            idleCountdown = try StudyRules.heartbeat(idleCountdown, now: countdownStart.addingTimeInterval(Double(second)))
        }
        try check(idleCountdown.state == .paused(reason: "idle"), "The 10-minute idle boundary did not precede the countdown deadline")
        try check(try StudyRules.remainingSeconds(idleCountdown, now: countdownStart.addingTimeInterval(600)) == 1200, "Idle pause lost the remaining countdown")

        var checkInCountdown = try StudyRules.start(title: "Check-in boundary", subjectId: nil, targetMinutes: 90, timeZone: "Australia/Sydney", now: countdownStart)
        for second in stride(from: 15, through: 3600, by: 15) {
            checkInCountdown = try StudyRules.heartbeat(checkInCountdown, now: countdownStart.addingTimeInterval(Double(second)), activity: true)
        }
        try check(checkInCountdown.state == .paused(reason: "check-in"), "The hourly check-in did not precede the 90-minute countdown deadline")
        try check(try StudyRules.remainingSeconds(checkInCountdown, now: countdownStart.addingTimeInterval(3600)) == 1800, "Hourly check-in lost the remaining countdown")
        print("PASS countdown deadline keeps idle and hourly check-in boundaries")

        func manual(_ start: String, _ end: String) throws -> StudySession {
            try StudyRules.manual(title: "DST", subjectId: nil, timeZone: "Australia/Sydney", start: Clock.date(start), end: Clock.date(end), now: now)
        }
        let shortDay = try manual("2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z")
        let longDay = try manual("2026-04-04T13:00:00.000Z", "2026-04-05T14:00:00.000Z")
        try check(StudyRules.weeklyDuration([shortDay], at: Clock.date("2026-10-04T12:00:00.000Z"), timeZone: "Australia/Sydney") == 82800, "Spring DST day must have 23 elapsed hours")
        try check(StudyRules.weeklyDuration([longDay], at: Clock.date("2026-04-05T12:00:00.000Z"), timeZone: "Australia/Sydney") == 90000, "Autumn DST day must have 25 elapsed hours")
        try check(StudyRules.weekStart(at: Clock.date("2026-10-18T12:59:59.000Z"), timeZone: "Australia/Sydney") == "2026-10-12", "Sunday week boundary wrong")
        try check(StudyRules.weekStart(at: Clock.date("2026-10-18T13:00:00.000Z"), timeZone: "Australia/Sydney") == "2026-10-19", "Monday week boundary wrong")
        print("PASS Sydney DST elapsed durations and local Monday boundary")

        let historyOlder = try practiceSnapshot(practiceRecord("history-older", createdAt:"2026-10-20T01:00:00.000Z",
            answers:["q1":"Some work"],score:0.25,total:1,feedback:[practiceMark("q1",score:0.25,maxScore:1)]))
        let historyLatest = try practiceSnapshot(practiceRecord("history-latest", createdAt:"2026-10-22T01:00:00.000Z",
            answers:["q1":"More work"],score:0.75,total:1,feedback:[practiceMark("q1",score:0.75,maxScore:1)]))
        let partialComparison = PracticeAttemptComparison(first:historyOlder,second:historyLatest)
        try check(partialComparison?.percentagePointChange == 50, "Normalized practice score delta is wrong")
        try check(partialComparison?.questions.first?.change == .improved
                  && partialComparison?.questions.first?.repeatedMistake == true,
                  "Partial improvement must keep its separate repeated-mistake flag")

        let comparisonEarlier = try practiceSnapshot(practiceRecord("comparison-earlier", createdAt:"2026-10-19T01:00:00.000Z",
            answers:["partial":"first response","mistake":"wrong","lower":"strong response"],score:1,total:6,
            feedback:[practiceMark("partial",score:1,maxScore:2),practiceMark("mistake",score:0,maxScore:1),
                      practiceMark("lower",score:1,maxScore:2)]))
        let comparisonLater = try practiceSnapshot(practiceRecord("comparison-later", createdAt:"2026-10-23T01:00:00.000Z",
            answers:["partial":"improved response","mistake":"still wrong","lower":"weaker response"],score:2,total:6,
            feedback:[practiceMark("partial",score:1.5,maxScore:2),practiceMark("mistake",score:0,maxScore:1),
                      practiceMark("lower",score:0,maxScore:2)]))
        let lowerComparison = PracticeAttemptComparison(first:comparisonEarlier,second:comparisonLater)
        try check(lowerComparison?.questions.first(where: { $0.id == "lower" })?.change == .lower
                  && lowerComparison?.repeatedMistakeCount == 3,
                  "Answered lower-mark question and repeated-mistake count must match the comparison test scenario")

        let unanswered = try practiceSnapshot(practiceRecord("history-unanswered", createdAt:"2026-10-23T01:00:00.000Z",
            answers:["q1":"  "],score:0,total:1,feedback:[practiceMark("q1",score:0,maxScore:1)]))
        let unansweredComparison = PracticeAttemptComparison(first:historyOlder,second:unanswered)
        try check(unansweredComparison?.questions.first?.change == .unanswered
                  && unansweredComparison?.repeatedMistakeCount == 0,
                  "Unanswered questions must not count as repeated mistakes")

        let changedMaximum = try practiceSnapshot(practiceRecord("history-changed-maximum", createdAt:"2026-10-24T01:00:00.000Z",
            answers:["q1":"More work"],score:1,total:2,feedback:[practiceMark("q1",score:1,maxScore:2)]))
        let changedComparison = PracticeAttemptComparison(first:historyOlder,second:changedMaximum)
        try check(changedComparison?.questions.first?.change == .changedMarking
                  && changedComparison?.overallTrend == nil,
                  "Changed per-question maxima must not claim an overall improvement")

        let duplicateFeedback = try practiceSnapshot(practiceRecord("history-duplicate", createdAt:"2026-10-25T01:00:00.000Z",
            answers:["q1":"Answer"],score:1,total:1,
            feedback:[practiceMark("q1",score:1,maxScore:1),practiceMark("q1",score:1,maxScore:1)]))
        let duplicateComparison = PracticeAttemptComparison(first:historyLatest,second:duplicateFeedback)
        try check(duplicateComparison?.sameMarking == false
                  && duplicateComparison?.questions.first?.change == .ungraded,
                  "Duplicate feedback must remain ungraded and cannot establish same marking")

        let invalidDate = try practiceSnapshot(practiceRecord("legacy-z", createdAt:"legacy-z"))
        let otherInvalidDate = try practiceSnapshot(practiceRecord("legacy-a", createdAt:"legacy-a"))
        try check(PracticeAttemptChronology.chronological([invalidDate,otherInvalidDate,historyOlder]).map(\.recordId)
                  == ["history-older","legacy-a","legacy-z"],
                  "Valid attempt dates must precede invalid legacy dates; invalid dates sort lexically")
        let zuluTie = try practiceSnapshot(practiceRecord("z-at-01",createdAt:"2026-10-22T01:00:00Z"))
        let offsetTie = try practiceSnapshot(practiceRecord("a-at-12",createdAt:"2026-10-22T12:00:00+11:00"))
        let legacyTie = try practiceSnapshot(practiceRecord("duplicate",kind:"attempt",createdAt:"2026-10-22T01:00:00Z"))
        let versionedTie = try practiceSnapshot(practiceRecord("duplicate",kind:"practice.attempt",createdAt:"2026-10-22T01:00:00Z"))
        try check(PracticeAttemptChronology.chronological([zuluTie,offsetTie]).map(\.recordId) == ["a-at-12","z-at-01"],
                  "Equal parsed instants must use attempt ID rather than timestamp string order")
        try check(PracticeAttemptChronology.chronological([versionedTie,legacyTie]).map(\.id)
                  == ["attempt/duplicate","practice.attempt/duplicate"],
                  "Duplicate IDs across attempt kinds need a deterministic replica-key tie-breaker")

        let deletedResourceAttempt = try practiceSnapshot(practiceRecord("deleted-history", kind:"attempt",
            resourceId:"deleted-resource",createdAt:"2026-10-18T01:00:00.000Z",
            answers:["saved-question-id":"Saved answer"],score:1,total:1,
            feedback:[practiceMark("saved-question-id",score:1,maxScore:1)]))
        try check(deletedResourceAttempt.questions.first?.id == "saved-question-id"
                  && deletedResourceAttempt.questions.first?.answer == "Saved answer",
                  "Deleted-resource history must stay readable from saved attempt IDs")
        print("PASS attempt chronology, normalized changes, repeated-mistake and unanswered distinctions, marking validity, deleted-resource evidence")

        let pairingCode = String(repeating: "a", count: 64)
        for address in ["https://cloud.example/pair#code=\(pairingCode)", "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(pairingCode)"] {
            guard let link = URL(string: address) else { throw VerificationFailure(description: "Invalid pairing fixture URL") }
            let invitation = try CloudURL.pairing(link)
            try check(invitation.baseURL.host == "cloud.example" && invitation.code == pairingCode, "Pairing link changed cloud origin or secret")
        }
        for address in [
            "http://cloud.example/pair#code=\(pairingCode)",
            "https://user@cloud.example/pair#code=\(pairingCode)",
            "https://cloud.example/pair?code=\(pairingCode)",
            "https://cloud.example/pair?extra=1#code=\(pairingCode)",
            "https://cloud.example/pair/#code=\(pairingCode)",
            "https://cloud.example/p%61ir#code=\(pairingCode)",
            "https://cloud.example/pair#code=\(pairingCode)&code=\(pairingCode)",
            "https://cloud.example/pair#code=\(pairingCode)&extra=1",
            "https://cloud.example/pair#code=short",
            "https://cloud.example/pair#code=\(String(repeating: "a", count: 201))",
            "https://cloud.example/pair#code=%25\(pairingCode)"
        ] {
            guard let link = URL(string: address) else { throw VerificationFailure(description: "Invalid rejection fixture URL") }
            try check((try? CloudURL.pairing(link)) == nil, "Accepted malformed pairing link")
        }
        print("PASS canonical HTTPS and legacy pairing links; malformed origins, paths, secrets and duplicate fields rejected")
        print("Verified local CentreCore behavior. Network fixture is simulated; no hosted/provider proof.")
    }
}
