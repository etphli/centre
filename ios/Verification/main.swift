import Foundation
import CentreCore

private struct VerificationFailure: Error, CustomStringConvertible {
    let description: String
}
private func check(_ condition: @autoclosure () throws -> Bool, _ outcome: String) throws {
    guard try condition() else { throw VerificationFailure(description: outcome) }
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
        let recovered = try StudyRules.recover(imported, now: now, restart: true)
        try check(recovered.state == .paused(reason: "recovery"), "Imported timer kept running")
        try check(recovered.segments.last?.end == "2026-10-22T00:00:15.000Z", "Recovery credited time after checkpoint")
        try check(StudyRules.weeklyDuration([recovered], at: now, timeZone: "Australia/Sydney") == 15, "Recovered duration exceeded checkpoint")
        try check(StudyRules.recover(recovered, now: now, restart: true) == recovered, "Recovery was not idempotent")
        print("PASS real timer JSON import pauses at persisted checkpoint without closed-app credit")

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
        print("Verified local CentreCore behavior. Network fixture is simulated; no hosted/provider proof.")
    }
}
